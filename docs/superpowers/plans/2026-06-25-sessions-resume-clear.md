# Sessions: safe default id + external resume/clear — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the cross-restart transcript-leak bug and expose session management (`resume`/`clear`/`deleteSession`/`listSessions`/`sessionId`) on the lite-agent.

**Architecture:** Core stays primitive — only its default session id changes from a process-local counter to a unique value. The sdk `jsonlStore` grows `list()`/`delete()` (typed `SessionStore`); `createLiteAgent` returns a stateful `LiteAgent` that owns a current session id and injects it into `run`/`send`. The example CLI switches to server-side history (send only the new turn) and adds REPL commands.

**Tech Stack:** TypeScript (ESM, strict), pnpm workspaces, vitest, `fakeProvider` golden tests, changesets.

**Spec:** `docs/superpowers/specs/2026-06-25-sessions-resume-clear-design.md`

---

## File Structure

- `packages/core/src/createAgent.ts` — **modify**: default session id `s${++counter}` → `randomUUID()`; remove the counter.
- `packages/sdk/src/store.ts` — **modify**: add `SessionInfo`, `SessionStore`, `newSessionId()`, `isSessionStore()`; `jsonlStore` returns `SessionStore` (gains `list`/`delete`).
- `packages/sdk/src/createLiteAgent.ts` — **modify**: add `LiteAgent` interface; return a stateful wrapper.
- `packages/sdk/src/index.ts` — **modify**: export the new types/helpers.
- `examples/cli/src/main.ts` — **modify**: server-side history + `/sessions`,`/resume`,`/clear`,`/delete` commands; print `[session]` at startup.
- `.changeset/sessions-resume-clear.md` — **create**.
- `CLAUDE.md` — **modify**: one-line note on the session-management API.

**Test files:**
- `packages/core/test/createAgent.test.ts` — **modify**: assert the default id is unique (uuid form).
- `packages/sdk/test/store.test.ts` — **modify**: `list`/`delete`/`newSessionId`/`isSessionStore`.
- `packages/sdk/test/sessions.test.ts` — **create**: wrapper behavior + restart-isolation regression.

> **Build choreography (non-obvious):** sdk tests import `@lite-agent/core` via its built `dist/`, not src. After changing core, run `pnpm --filter @lite-agent/core build` before relying on it from sdk. Core's own tests import `../src` and need no build. The sdk filter is `@lite-agent/sdk` (the unscoped `lite-agent` is the private workspace root).

---

## Task 1: Core — unique default session id (C)

**Files:**
- Modify: `packages/core/src/createAgent.ts` (imports; remove `let sessionCounter = 0` at line 30; line 50)
- Test: `packages/core/test/createAgent.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/createAgent.test.ts`:

```ts
test("the default session id is a unique value, not a restart-colliding counter", async () => {
  const seen: string[] = [];
  const spyStore = {
    load: async () => null,
    save: async (id: string) => {
      seen.push(id);
    },
  };
  await createAgent({
    model: fakeProvider([{ text: "x", message: { role: "assistant", content: [textBlock("x")] } }]),
    codec: nativeCodec(),
    store: spyStore,
  }).send("hi");
  // Old behavior persisted under "s1"/"sN"; the fix uses a unique uuid.
  expect(seen[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lite-agent/core test -- createAgent`
Expected: FAIL — `seen[0]` is `"s1"` (or `"sN"`), which does not match the uuid pattern.

- [ ] **Step 3: Implement the unique default**

In `packages/core/src/createAgent.ts`, add the import near the top (after the existing `import` lines, e.g. below line 7):

```ts
import { randomUUID } from "node:crypto";
```

Delete the module-level counter (line 30):

```ts
let sessionCounter = 0;
```

Change the default in `run` (line 50) from:

```ts
      const sessionId = opts?.sessionId ?? `s${++sessionCounter}`;
```

to:

```ts
      const sessionId = opts?.sessionId ?? randomUUID();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @lite-agent/core test -- createAgent`
Expected: PASS (all tests in the file, including the existing resume test).

- [ ] **Step 5: Build core so dependents see the change, then commit**

Run: `pnpm --filter @lite-agent/core build`
Expected: tsup builds `dist/` with no errors.

```bash
git add packages/core/src/createAgent.ts packages/core/test/createAgent.test.ts
git commit -m "fix(core): unique default session id (no cross-restart counter collision)"
```

---

## Task 2: sdk — `SessionStore` (`list`/`delete`) + `newSessionId` + `isSessionStore`

**Files:**
- Modify: `packages/sdk/src/store.ts` (full replacement below)
- Test: `packages/sdk/test/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the import block at the top of `packages/sdk/test/store.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonlStore, newSessionId, isSessionStore } from "../src/store";
import { memoryStore } from "@lite-agent/core";
import type { Message } from "@lite-agent/core";
```

Append these tests to the same file:

```ts
test("list() returns ids with mtime, most-recent first", async () => {
  const dir = freshDir();
  const store = jsonlStore({ dir });
  await store.save("older", [{ role: "user", content: "a" }]);
  await store.save("newer", [{ role: "user", content: "b" }]);
  // Force deterministic mtimes so ordering is not a race.
  utimesSync(join(dir, "older.jsonl"), new Date(1000), new Date(1000));
  utimesSync(join(dir, "newer.jsonl"), new Date(2000), new Date(2000));
  const list = await store.list();
  expect(list.map((s) => s.id)).toEqual(["newer", "older"]);
  expect(list[0]!.mtime).toBeGreaterThan(list[1]!.mtime);
});

test("list() returns [] for a missing directory", async () => {
  const store = jsonlStore({ dir: join(tmpdir(), "lite-store-missing-xyz123") });
  expect(await store.list()).toEqual([]);
});

test("delete() removes a session file and is idempotent", async () => {
  const dir = freshDir();
  const store = jsonlStore({ dir });
  await store.save("gone", [{ role: "user", content: "x" }]);
  expect(existsSync(join(dir, "gone.jsonl"))).toBe(true);
  await store.delete("gone");
  expect(existsSync(join(dir, "gone.jsonl"))).toBe(false);
  await store.delete("gone"); // missing file → no throw
});

test("newSessionId() is unique and sortable-formatted", () => {
  const a = newSessionId();
  const b = newSessionId();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^s-[0-9a-z]+-[0-9a-f]{6}$/);
});

test("isSessionStore distinguishes jsonlStore from a plain Store", () => {
  expect(isSessionStore(jsonlStore({ dir: freshDir() }))).toBe(true);
  expect(isSessionStore(memoryStore())).toBe(false);
  expect(isSessionStore(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lite-agent/sdk test -- store`
Expected: FAIL — `jsonlStore(...).list`/`.delete` are not functions; `newSessionId`/`isSessionStore` are not exported.

- [ ] **Step 3: Implement — full replacement of `packages/sdk/src/store.ts`**

```ts
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Store, Message } from "@lite-agent/core";

export interface JsonlStoreOptions {
  /** Directory holding one `<sessionId>.jsonl` transcript per session. */
  dir: string;
}

/** Lightweight metadata for one persisted session. */
export interface SessionInfo {
  id: string;
  mtime: number; // fs mtime in ms since epoch
}

/** A Store that can also enumerate and delete its sessions. */
export interface SessionStore extends Store {
  list(): Promise<SessionInfo[]>;
  delete(id: string): Promise<void>;
}

const SUFFIX = ".jsonl";

// Filesystem Store: each session is a JSONL file (one Message per line) under
// `dir`, so transcripts survive process restarts (resume). The id is sanitized
// to a flat filename so a traversal-style id can't escape `dir`.
export function jsonlStore(opts: JsonlStoreOptions): SessionStore {
  const fileFor = (id: string) =>
    join(opts.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}${SUFFIX}`);
  return {
    async load(id) {
      const file = fileFor(id);
      if (!existsSync(file)) return null;
      return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Message);
    },
    async save(id, messages) {
      mkdirSync(opts.dir, { recursive: true });
      const body = messages.map((m) => JSON.stringify(m)).join("\n");
      writeFileSync(fileFor(id), messages.length ? body + "\n" : "");
    },
    async list() {
      if (!existsSync(opts.dir)) return [];
      return readdirSync(opts.dir)
        .filter((f) => f.endsWith(SUFFIX))
        .map((f) => ({
          id: f.slice(0, -SUFFIX.length),
          mtime: statSync(join(opts.dir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
    },
    async delete(id) {
      const file = fileFor(id);
      if (existsSync(file)) unlinkSync(file);
    },
  };
}

/** Unique, creation-sortable session id (replaces the old process-local counter). */
export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** True when a Store also supports session listing/deletion (e.g. jsonlStore). */
export function isSessionStore(store: Store | undefined): store is SessionStore {
  return (
    !!store &&
    typeof (store as Partial<SessionStore>).list === "function" &&
    typeof (store as Partial<SessionStore>).delete === "function"
  );
}
```

> Note: `memoryStore` is unrelated and lives in `@lite-agent/core`; it stays a plain `Store` (no `list`/`delete`), which is why `isSessionStore(memoryStore())` is `false`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- store`
Expected: PASS (new tests + the four pre-existing `jsonlStore` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/store.ts packages/sdk/test/store.test.ts
git commit -m "feat(sdk): jsonlStore gains list/delete (SessionStore) + newSessionId/isSessionStore"
```

---

## Task 3: sdk — stateful `LiteAgent` wrapper

**Files:**
- Modify: `packages/sdk/src/createLiteAgent.ts` (imports; add `LiteAgent`; change return type + return value)
- Test: `packages/sdk/test/sessions.test.ts` (create)

- [ ] **Step 1: Write the failing tests** — create `packages/sdk/test/sessions.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock, memoryStore } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { jsonlStore } from "../src/store";

const freshDir = () => mkdtempSync(join(tmpdir(), "lite-sessions-"));
const reply = (text: string) =>
  fakeProvider([{ text, message: { role: "assistant", content: [textBlock(text)] } }]);

test("each agent gets a unique, non-counter default session id", () => {
  const mk = () => createLiteAgent({ model: reply("x"), workdir: process.cwd(), cleanup: false });
  const a = mk();
  const b = mk();
  expect(a.sessionId).not.toBe(b.sessionId);
  expect(a.sessionId).not.toMatch(/^s\d+$/); // not the old counter form
  expect(a.sessionId).toMatch(/^s-[0-9a-z]+-[0-9a-f]{6}$/);
});

test("resume(id) reconstructs an existing session's history", async () => {
  const dir = freshDir();
  const a1 = createLiteAgent({ model: reply("r1"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  await a1.send([{ role: "user", content: "first" }]);
  const id = a1.sessionId;

  const a2 = createLiteAgent({ model: reply("r2"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  a2.resume(id);
  const r = await a2.send([{ role: "user", content: "second" }]);
  expect(r.messages).toContainEqual({ role: "user", content: "first" });
  expect(r.messages).toContainEqual({ role: "user", content: "second" });
});

test("clear() rotates to a new session and keeps the old transcript", async () => {
  const dir = freshDir();
  const agent = createLiteAgent({
    model: fakeProvider([
      { text: "a", message: { role: "assistant", content: [textBlock("a")] } },
      { text: "b", message: { role: "assistant", content: [textBlock("b")] } },
    ]),
    workdir: process.cwd(),
    store: jsonlStore({ dir }),
    cleanup: false,
  });
  const id1 = agent.sessionId;
  await agent.send([{ role: "user", content: "first" }]);
  const id2 = agent.clear();
  expect(id2).not.toBe(id1);
  expect(agent.sessionId).toBe(id2);
  await agent.send([{ role: "user", content: "second" }]);
  const ids = (await agent.listSessions()).map((s) => s.id);
  expect(ids).toContain(id1); // old transcript still on disk
  expect(ids).toContain(id2);
});

test("deleteSession removes a transcript from listSessions", async () => {
  const dir = freshDir();
  const agent = createLiteAgent({ model: reply("a"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  const id = agent.sessionId;
  await agent.send([{ role: "user", content: "hi" }]);
  expect((await agent.listSessions()).map((s) => s.id)).toContain(id);
  await agent.deleteSession(id);
  expect((await agent.listSessions()).map((s) => s.id)).not.toContain(id);
});

test("session management throws when persistence is disabled", async () => {
  const agent = createLiteAgent({ model: reply("x"), workdir: process.cwd(), sessions: false, cleanup: false });
  await expect(agent.listSessions()).rejects.toThrow(/session-capable store/);
  await expect(agent.deleteSession("x")).rejects.toThrow(/session-capable store/);
});

test("session management throws with a store lacking list/delete", async () => {
  const agent = createLiteAgent({ model: reply("x"), workdir: process.cwd(), store: memoryStore(), cleanup: false });
  await expect(agent.listSessions()).rejects.toThrow(/session-capable store/);
});

test("a fresh agent over the same sessions dir does not resume a prior agent's session", async () => {
  const dir = freshDir();
  const a1 = createLiteAgent({ model: reply("r1"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  await a1.send([{ role: "user", content: "first" }]);
  // Simulates a process restart: new agent, new default id, same dir.
  const a2 = createLiteAgent({ model: reply("r2"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  const r = await a2.send([{ role: "user", content: "second" }]);
  expect(r.messages).not.toContainEqual({ role: "user", content: "first" });
  expect(r.messages).toContainEqual({ role: "user", content: "second" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lite-agent/sdk test -- sessions`
Expected: FAIL — `agent.sessionId`/`resume`/`clear`/`listSessions`/`deleteSession` do not exist on the returned agent.

- [ ] **Step 3: Implement the wrapper in `packages/sdk/src/createLiteAgent.ts`**

(a) Add `AgentError` to the value import from core (the existing line that imports `createAgent, nativeCodec, ...`):

```ts
import {
  createAgent,
  nativeCodec,
  permission,
  compaction,
  reactiveCompaction,
  defaultCompactor,
  AgentError,
} from "@lite-agent/core";
```

(b) Add imports for the store helpers (near the other `./` imports, e.g. after the `jsonlStore` import):

```ts
import { jsonlStore, newSessionId, isSessionStore } from "./store";
import type { SessionInfo, SessionStore } from "./store";
```

(The file already imports `jsonlStore` from `./store`; merge `newSessionId, isSessionStore` into that existing line instead of duplicating it.)

(c) Add the `LiteAgent` interface just above `export function createLiteAgent` (after the `CreateLiteAgentConfig` interface):

```ts
export interface LiteAgent extends Agent {
  /** The session id `run`/`send` use when none is passed in `opts`. */
  readonly sessionId: string;
  /** Switch the current session to an existing id (lenient — unknown id starts empty). */
  resume(id: string): void;
  /** Rotate to a brand-new empty session; returns the new id. Does not delete the old transcript. */
  clear(): string;
  /** Delete a persisted session transcript. Requires a session-capable store. */
  deleteSession(id: string): Promise<void>;
  /** List persisted sessions (id + mtime, most-recent first). Requires a session-capable store. */
  listSessions(): Promise<SessionInfo[]>;
}
```

(d) Change the function signature return type from `: Agent` to `: LiteAgent`:

```ts
export function createLiteAgent(cfg: CreateLiteAgentConfig): LiteAgent {
```

(e) Replace the final `return createAgent({ ... });` block with:

```ts
  const core = createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec: nativeCodec(),
    tools,
    use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    sandbox: cfg.sandbox,
    store,
    input: cfg.onAskUser,
  });

  // Stateful session ownership lives here (sdk), not in the primitive core agent.
  let currentSessionId = newSessionId();
  const sessionStore = isSessionStore(store) ? store : undefined;
  const requireSessionStore = (): SessionStore => {
    if (!sessionStore)
      throw new AgentError("session management requires a session-capable store");
    return sessionStore;
  };

  return {
    run: (input, opts) =>
      core.run(input, { signal: opts?.signal, sessionId: opts?.sessionId ?? currentSessionId }),
    send: (input, opts) =>
      core.send(input, { signal: opts?.signal, sessionId: opts?.sessionId ?? currentSessionId }),
    get sessionId() {
      return currentSessionId;
    },
    resume(id: string) {
      currentSessionId = id;
    },
    clear() {
      currentSessionId = newSessionId();
      return currentSessionId;
    },
    deleteSession: (id: string) => requireSessionStore().delete(id),
    listSessions: () => requireSessionStore().list(),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- sessions`
Expected: PASS (all 7 tests).

Then run the full sdk suite to confirm no regressions (the subagent-spawn path passes an explicit `sessionId`, which the wrapper still honors):

Run: `pnpm --filter @lite-agent/sdk test`
Expected: PASS (all existing tests, including `subagents`, `createLiteAgent`, `query`).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/createLiteAgent.ts packages/sdk/test/sessions.test.ts
git commit -m "feat(sdk): createLiteAgent returns a stateful LiteAgent (resume/clear/list/delete/sessionId)"
```

---

## Task 4: Exports + changeset + CLAUDE.md

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Create: `.changeset/sessions-resume-clear.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the public exports** in `packages/sdk/src/index.ts`.

Change the `./store` export lines from:

```ts
export { jsonlStore } from "./store";
export type { JsonlStoreOptions } from "./store";
```

to:

```ts
export { jsonlStore, newSessionId, isSessionStore } from "./store";
export type { JsonlStoreOptions, SessionStore, SessionInfo } from "./store";
```

Change the `createLiteAgent` type export from:

```ts
export type { CreateLiteAgentConfig } from "./createLiteAgent";
```

to:

```ts
export type { CreateLiteAgentConfig, LiteAgent } from "./createLiteAgent";
```

- [ ] **Step 2: Typecheck the sdk to verify the exports resolve**

Run: `pnpm --filter @lite-agent/sdk typecheck`
Expected: PASS (no missing-export or type errors).

- [ ] **Step 3: Create the changeset** `.changeset/sessions-resume-clear.md`:

```md
---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
"@lite-agent/provider": minor
"@lite-agent/sandbox-anthropic": minor
---

feat: session management. `createLiteAgent` now returns a stateful `LiteAgent` that owns a current session and exposes `sessionId`, `resume(id)`, `clear()`, `deleteSession(id)`, and `listSessions()`. `jsonlStore` gains `list()`/`delete()` and is typed `SessionStore`; new `newSessionId`/`isSessionStore` helpers. The default session id is now a unique value instead of a process-local counter — fixing a cross-restart bug where a fresh run silently resumed (and kept growing) the previous run's `s1` transcript. The example CLI switches to server-side history and adds `/sessions`, `/resume`, `/clear`, `/delete`.
```

- [ ] **Step 4: Add a CLAUDE.md note.** In `CLAUDE.md`, in the `### SDK batteries (lite-agent)` paragraph, append this sentence at the end of the paragraph:

```md
`createLiteAgent` returns a `LiteAgent` that owns a current session: `run`/`send` default to it, and `resume(id)` / `clear()` / `deleteSession(id)` / `listSessions()` / `sessionId` manage it. The default session id is unique per agent (not a process-local counter), and the default `jsonlStore` is a `SessionStore` (supports `list`/`delete`).
```

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/index.ts .changeset/sessions-resume-clear.md CLAUDE.md
git commit -m "feat(sdk): export session-management API; changeset + docs"
```

---

## Task 5: Example CLI — server-side history + resume UX

**Files:**
- Modify: `examples/cli/src/main.ts`

This is a private demo with no automated test harness; verification is `typecheck` + a manual smoke test.

- [ ] **Step 1: Remove the now-unused `Message` import.** In `examples/cli/src/main.ts`, the type import block (lines 7-14) imports `Message`. After this task `history` is gone, so drop `Message` from that import. New block:

```ts
import type {
  AgentEvent,
  ApprovalHandler,
  InputHandler,
  UserAnswer,
  UserQuestion,
} from "@lite-agent/sdk";
```

- [ ] **Step 2: Print the session id at startup.** Immediately after the `createLiteAgent({ ... })` call (after its closing `});`, before `function render`), add:

```ts
process.stdout.write(`\x1b[90m[session] ${agent.sessionId}\x1b[0m\n`);
```

- [ ] **Step 3: Rewrite the `main()` loop body for commands + server-side history.** Replace the current `main()` function (from `async function main(): Promise<void> {` through its closing `}`) with:

```ts
async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const text = (await readPrompt(rl)).trim();
    if (!text) continue;
    if (["q", "exit"].includes(text.toLowerCase())) break;

    // Session-management commands are handled locally (never sent to the model).
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      try {
        if (cmd === "sessions") {
          const list = await agent.listSessions();
          if (!list.length) process.stdout.write("\x1b[90m(no sessions)\x1b[0m\n");
          for (const s of list)
            process.stdout.write(`  ${s.id}\t${new Date(s.mtime).toLocaleString()}\n`);
        } else if (cmd === "resume") {
          if (!arg) process.stdout.write("\x1b[31musage: /resume <id>\x1b[0m\n");
          else {
            agent.resume(arg);
            process.stdout.write(`\x1b[90m[session] ${agent.sessionId}\x1b[0m\n`);
          }
        } else if (cmd === "clear") {
          process.stdout.write(`\x1b[90m[session] ${agent.clear()} (new)\x1b[0m\n`);
        } else if (cmd === "delete") {
          if (!arg) process.stdout.write("\x1b[31musage: /delete <id>\x1b[0m\n");
          else {
            await agent.deleteSession(arg);
            process.stdout.write(`\x1b[90m[deleted] ${arg}\x1b[0m\n`);
          }
        } else {
          process.stdout.write(`\x1b[31munknown command: /${cmd}\x1b[0m\n`);
        }
      } catch (e) {
        process.stdout.write(`\n\x1b[31m[error] ${(e as Error).message}\x1b[0m\n`);
      }
      continue;
    }

    const ac = new AbortController();
    rl.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (key: Buffer) => {
      if (pendingApproval) {
        const resolve = pendingApproval;
        pendingApproval = null;
        const ch = key.toString();
        const allow = ch === "y" || ch === "Y";
        process.stdout.write("\n");
        resolve(allow ? "allow" : "deny");
        return;
      }
      if (pendingInput) {
        const b = key[0];
        if (b === 0x0d || b === 0x0a) {
          const { resolve, buffer } = pendingInput;
          pendingInput = null;
          process.stdout.write("\n");
          resolve(buffer);
        } else if (b === 0x7f || b === 0x08) {
          if (pendingInput.buffer.length) {
            pendingInput.buffer = pendingInput.buffer.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (b !== 0x1b) {
          const ch = key.toString();
          pendingInput.buffer += ch;
          process.stdout.write(ch);
        }
        return;
      }
      if (key[0] === 0x1b && key.length === 1) {
        ac.abort();
        process.stdout.write("\n\x1b[33m[ESC] interrupted\x1b[0m\n");
      }
    };
    process.stdin.on("data", onKey);

    try {
      // Server-side history: send only the new turn; the kernel reloads the
      // session's transcript from the store via the agent's current sessionId.
      const gen = agent.run([{ role: "user", content: text }], { signal: ac.signal });
      let r = await gen.next();
      while (!r.done) {
        render(r.value);
        r = await gen.next();
      }
    } catch (e) {
      process.stdout.write(`\n\x1b[31m[error] ${(e as Error).message}\x1b[0m\n`);
    } finally {
      pendingApproval = null;
      pendingInput = null;
      process.stdin.removeListener("data", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.resume();
    }
  }
  rl.close();
}
```

(Changes vs. the original: no `let history` and no `history.push`/`history = r.value.messages`; the `if (text.startsWith("/"))` command block; `agent.run([{ role: "user", content: text }], …)`.)

- [ ] **Step 4: Rebuild the sdk so the example resolves the new API, then typecheck the example**

Run: `pnpm --filter @lite-agent/sdk build`
Expected: tsup builds with no errors.

Run: `pnpm --filter @lite-agent/example-cli typecheck`
Expected: PASS (no unused `Message`, all `agent.*` calls type-check).

- [ ] **Step 5: Manual smoke test**

Run: `pnpm dev`
Verify, in order:
1. Startup prints `[session] s-…`.
2. Ask "记住数字 42". Then ask "我刚让你记住什么数字？" → it answers 42 (history works within the process).
3. `Ctrl-C` / `q` to quit, then `pnpm dev` again. Ask "我刚让你记住什么数字？" → it does **not** know 42 (clean restart, new session id — the bug is fixed).
4. `/sessions` → lists prior session ids with timestamps.
5. `/resume <id of the first session>` then ask "我刚让你记住什么数字？" → answers 42 (resume works).
6. `/clear` → prints a new id; the prior context is gone but `/sessions` still lists it.
7. `/delete <id>` → that id disappears from `/sessions`.

- [ ] **Step 6: Commit**

```bash
git add examples/cli/src/main.ts
git commit -m "feat(example-cli): server-side history + /sessions /resume /clear /delete"
```

---

## Final verification

- [ ] **Full build + test + typecheck across the workspace (topological order):**

Run: `pnpm -r build && pnpm -r test && pnpm -r typecheck`
Expected: all packages build, all tests pass, no type errors.

- [ ] **Then** finish with **superpowers:finishing-a-development-branch** (branch `feat/sessions-resume-clear`).
