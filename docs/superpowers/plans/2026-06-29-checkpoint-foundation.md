# Checkpoint Foundation (Event-Sourced Persistence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace lite-agent's whole-array session store with an append-only, event-sourced `Checkpointer` that persists each tool result mid-turn, is concurrency-safe for multiple clients, and ships a pluggable backend abstraction (file default + optional SQLite package).

**Architecture:** A `Checkpointer` strategy stores an append-only log of `SessionEvent`s keyed by a monotonic per-session `seq`; conversation state is a deterministic fold over the log (`foldEvents`). The kernel loads by replaying and appends events at each state change (user / assistant / per-tool-result). Backends: `memoryCheckpointer` + `fileCheckpointer` (core/sdk) and `@lite-agent/checkpoint-sqlite` (optional). A shared conformance suite pins backend behavior.

**Tech Stack:** TypeScript/ESM monorepo, vitest, tsup, changesets. SQLite backend uses `better-sqlite3` (mature, synchronous, works on Node ≥ 20; native build is acceptable for an opt-in package).

**Spec:** `docs/superpowers/specs/2026-06-29-checkpoint-foundation-design.md`

**Deviation from spec (intentional):** The spec's §4 listed a `compaction` SessionEvent. It is **dropped**. Compaction is a live in-memory concern (it shrinks the context handed to the model); the canonical event log stays full, and on resume the full history replays and the compactor re-applies as needed. Persisting a compaction event would risk re-inflating compacted history on replay. Compaction-aware replay (store summary, replay only post-boundary) is a future optimization, not part of the foundation. So `SessionEvent = user | assistant | tool_result`.

---

## File Structure

**Create:**
- `packages/core/src/checkpoint.ts` — `SessionEvent`, `StoredEvent`, `SessionInfo`, `Checkpointer`, `foldEvents`, `memoryCheckpointer`, `legacyStoreAdapter`.
- `packages/core/src/testing/checkpointerConformance.ts` — shared backend conformance cases (uses `node:assert/strict`, no vitest).
- `packages/core/test/checkpoint-fold.test.ts`, `packages/core/test/checkpoint-memory.test.ts`, `packages/core/test/legacy-store-adapter.test.ts`, `packages/core/test/kernel-checkpoint.test.ts`.
- `packages/sdk/src/checkpoint.ts` — `fileCheckpointer`.
- `packages/sdk/test/fileCheckpointer.test.ts`.
- `packages/checkpoint-sqlite/` — new package (`package.json`, `tsup.config.ts`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`, `test/sqlite.test.ts`).

**Modify:**
- `packages/core/src/events.ts` — add `CheckpointConflictError`.
- `packages/core/src/index.ts` — export the new checkpoint API + conformance suite.
- `packages/core/src/kernel.ts` — load via `read`+`foldEvents`; append events; replace `store` with `checkpointer`.
- `packages/core/src/createAgent.ts` — accept `checkpointer?`; adapt legacy `store?`.
- `packages/sdk/src/createLiteAgent.ts` — default to `fileCheckpointer`; `checkpointer?` config; session mgmt via checkpointer.
- `packages/sdk/src/query.ts` — pass `checkpointer?` through.
- `packages/sdk/src/index.ts` — export `fileCheckpointer`.
- `packages/sdk/src/store.ts` — re-export core `SessionInfo` (remove local duplicate).
- `.changeset/config.json` — add `@lite-agent/checkpoint-sqlite` to the fixed group.

**Reference types (already exist):**
- `Message = { role: Role; content: string | ContentBlock[] }`, `AssistantMessage = { role: "assistant"; content: ContentBlock[] }`, `ToolResultBlock = { type: "tool_result"; id: string; content: string; isError?: boolean }`, `toolResultBlock(id, content, isError?)` — all in `packages/core/src/types.ts`.
- `Store = { load(id): Promise<Message[] | null>; save(id, messages): Promise<void> }` — `packages/core/src/strategies.ts:68`.
- `memoryStore(): Store` — `packages/core/src/store.ts`.
- `AgentError` — `packages/core/src/events.ts:12`.

---

## Task 1: Event model + foldEvents (core)

**Files:**
- Create: `packages/core/src/checkpoint.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/checkpoint-fold.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/checkpoint-fold.test.ts`:
```ts
import { expect, test } from "vitest";
import { foldEvents } from "../src/checkpoint";
import type { SessionEvent } from "../src/checkpoint";
import { textBlock, toolResultBlock } from "../src/types";

test("foldEvents rebuilds messages and coalesces consecutive tool_result events", () => {
  const events: SessionEvent[] = [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "assistant", message: { role: "assistant", content: [textBlock("ok")] } },
    { type: "tool_result", result: toolResultBlock("a", "ra"), turn: 1 },
    { type: "tool_result", result: toolResultBlock("b", "rb"), turn: 1 },
    { type: "assistant", message: { role: "assistant", content: [textBlock("done")] } },
  ];
  expect(foldEvents(events)).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: [textBlock("ok")] },
    { role: "user", content: [toolResultBlock("a", "ra"), toolResultBlock("b", "rb")] },
    { role: "assistant", content: [textBlock("done")] },
  ]);
});

test("foldEvents flushes a trailing tool_result group", () => {
  const events: SessionEvent[] = [
    { type: "assistant", message: { role: "assistant", content: [textBlock("x")] } },
    { type: "tool_result", result: toolResultBlock("c", "rc"), turn: 1 },
  ];
  expect(foldEvents(events)).toEqual([
    { role: "assistant", content: [textBlock("x")] },
    { role: "user", content: [toolResultBlock("c", "rc")] },
  ]);
});

test("foldEvents on an empty log is an empty array", () => {
  expect(foldEvents([])).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test -- --run checkpoint-fold`
Expected: FAIL — cannot find module `../src/checkpoint`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/checkpoint.ts`:
```ts
import type { AssistantMessage, Message, ToolResultBlock } from "./types";

/** One appended fact about a session. The canonical persisted unit. */
export type SessionEvent =
  | { type: "user"; message: Message }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "tool_result"; result: ToolResultBlock; turn: number };

/** A SessionEvent as stored, with its monotonic seq and parent link. */
export type StoredEvent = {
  seq: number;
  sessionId: string;
  parentSeq: number | null;
  ts: string;
  event: SessionEvent;
};

/** Lightweight metadata for one persisted session. */
export interface SessionInfo {
  id: string;
  mtime: number; // ms since epoch, most-recent activity
}

/**
 * Rebuild conversation state from an event log. Consecutive `tool_result`
 * events coalesce into a single `{ role: "user", content: [blocks] }` message,
 * reproducing the kernel's turn shape (one user message per turn's results).
 */
export function foldEvents(events: SessionEvent[]): Message[] {
  const messages: Message[] = [];
  let pending: ToolResultBlock[] = [];
  const flush = () => {
    if (pending.length) {
      messages.push({ role: "user", content: pending });
      pending = [];
    }
  };
  for (const ev of events) {
    if (ev.type === "tool_result") {
      pending.push(ev.result);
      continue;
    }
    flush();
    messages.push(ev.message);
  }
  flush();
  return messages;
}
```

Add to `packages/core/src/index.ts` (near the other type exports):
```ts
export { foldEvents } from "./checkpoint";
export type { SessionEvent, StoredEvent, SessionInfo } from "./checkpoint";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/core test -- --run checkpoint-fold`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/checkpoint.ts packages/core/src/index.ts packages/core/test/checkpoint-fold.test.ts
git commit -m "feat(core): SessionEvent model + foldEvents"
```

---

## Task 2: Checkpointer interface + memoryCheckpointer + CheckpointConflictError (core)

**Files:**
- Modify: `packages/core/src/checkpoint.ts`, `packages/core/src/events.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/checkpoint-memory.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/checkpoint-memory.test.ts`:
```ts
import { expect, test } from "vitest";
import { memoryCheckpointer } from "../src/checkpoint";
import { CheckpointConflictError } from "../src/events";

const userEvt = (t: string) => ({ type: "user" as const, message: { role: "user" as const, content: t } });

test("append returns a monotonic head; read replays in seq order", async () => {
  const cp = memoryCheckpointer();
  expect(await cp.head("s")).toBe(0);
  const h1 = await cp.append("s", [userEvt("a"), userEvt("b")]);
  expect(h1).toBe(2);
  const h2 = await cp.append("s", [userEvt("c")]);
  expect(h2).toBe(3);
  const seen: number[] = [];
  for await (const e of cp.read("s")) seen.push(e.seq);
  expect(seen).toEqual([1, 2, 3]);
  expect(await cp.head("s")).toBe(3);
});

test("read({sinceSeq}) yields only later events", async () => {
  const cp = memoryCheckpointer();
  await cp.append("s", [userEvt("a"), userEvt("b"), userEvt("c")]);
  const seen: number[] = [];
  for await (const e of cp.read("s", { sinceSeq: 1 })) seen.push(e.seq);
  expect(seen).toEqual([2, 3]);
});

test("append with a stale expectedHead throws CheckpointConflictError", async () => {
  const cp = memoryCheckpointer();
  await cp.append("s", [userEvt("a")]); // head now 1
  await expect(cp.append("s", [userEvt("b")], 0)).rejects.toBeInstanceOf(CheckpointConflictError);
  // a correct expectedHead succeeds
  expect(await cp.append("s", [userEvt("b")], 1)).toBe(2);
});

test("list returns appended sessions; delete removes a log", async () => {
  const cp = memoryCheckpointer();
  await cp.append("s1", [userEvt("a")]);
  await cp.append("s2", [userEvt("b")]);
  expect((await cp.list()).map((i) => i.id).sort()).toEqual(["s1", "s2"]);
  await cp.delete("s1");
  expect((await cp.list()).map((i) => i.id)).toEqual(["s2"]);
  expect(await cp.head("s1")).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test -- --run checkpoint-memory`
Expected: FAIL — `memoryCheckpointer` / `CheckpointConflictError` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/core/src/events.ts` (after the other error classes):
```ts
export class CheckpointConflictError extends AgentError {
  constructor(readonly sessionId: string, readonly expected: number, readonly actual: number) {
    super(`checkpoint conflict on '${sessionId}': expected head ${expected}, found ${actual}`);
    this.name = "CheckpointConflictError";
  }
}
```

Add to `packages/core/src/checkpoint.ts`:
```ts
import { CheckpointConflictError } from "./events";

/** The persistence seam. Backend-agnostic; the evolution of the `Store` strategy. */
export interface Checkpointer {
  /** Append events; returns the new head seq. If `expectedHead` is given and the
   *  current head differs, throws CheckpointConflictError (optimistic concurrency). */
  append(sessionId: string, events: SessionEvent[], expectedHead?: number): Promise<number>;
  /** Replay events in seq order, optionally from `sinceSeq` (exclusive). */
  read(sessionId: string, opts?: { sinceSeq?: number }): AsyncIterable<StoredEvent>;
  /** Current head seq (0 when empty/unknown). */
  head(sessionId: string): Promise<number>;
  /** Known sessions, most-recent first. */
  list(): Promise<SessionInfo[]>;
  /** Delete a session's entire log. */
  delete(sessionId: string): Promise<void>;
}

/** Build StoredEvents for `events` starting after `fromSeq`. */
export function storeEvents(sessionId: string, fromSeq: number, events: SessionEvent[]): StoredEvent[] {
  const ts = new Date().toISOString();
  return events.map((event, i) => {
    const seq = fromSeq + i + 1;
    return { seq, sessionId, parentSeq: seq === 1 ? null : seq - 1, ts, event };
  });
}

/** In-memory Checkpointer (testing/ephemeral). */
export function memoryCheckpointer(): Checkpointer {
  const logs = new Map<string, StoredEvent[]>();
  const updated = new Map<string, number>();
  return {
    async append(sessionId, events, expectedHead) {
      const log = logs.get(sessionId) ?? [];
      const head = log.length ? log[log.length - 1]!.seq : 0;
      if (expectedHead !== undefined && expectedHead !== head)
        throw new CheckpointConflictError(sessionId, expectedHead, head);
      const stored = storeEvents(sessionId, head, events);
      log.push(...stored);
      logs.set(sessionId, log);
      updated.set(sessionId, Date.now());
      return log.length ? log[log.length - 1]!.seq : head;
    },
    async *read(sessionId, opts) {
      const log = logs.get(sessionId) ?? [];
      for (const e of log) if (opts?.sinceSeq === undefined || e.seq > opts.sinceSeq) yield e;
    },
    async head(sessionId) {
      const log = logs.get(sessionId);
      return log && log.length ? log[log.length - 1]!.seq : 0;
    },
    async list() {
      return [...logs.keys()]
        .map((id) => ({ id, mtime: updated.get(id) ?? 0 }))
        .sort((a, b) => b.mtime - a.mtime);
    },
    async delete(sessionId) {
      logs.delete(sessionId);
      updated.delete(sessionId);
    },
  };
}
```

Add to `packages/core/src/index.ts`:
```ts
export { memoryCheckpointer, storeEvents } from "./checkpoint";
export type { Checkpointer } from "./checkpoint";
```
And add `CheckpointConflictError` to the existing error export from `./events`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/core test -- --run checkpoint-memory`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/checkpoint.ts packages/core/src/events.ts packages/core/src/index.ts packages/core/test/checkpoint-memory.test.ts
git commit -m "feat(core): Checkpointer interface + memoryCheckpointer + CheckpointConflictError"
```

---

## Task 3: legacyStoreAdapter (core)

**Files:**
- Modify: `packages/core/src/checkpoint.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/legacy-store-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/legacy-store-adapter.test.ts`:
```ts
import { expect, test } from "vitest";
import { legacyStoreAdapter, foldEvents } from "../src/checkpoint";
import { memoryStore } from "../src/store";

const userEvt = (t: string) => ({ type: "user" as const, message: { role: "user" as const, content: t } });

test("appends fold to the wrapped Store and read replays the folded state", async () => {
  const store = memoryStore();
  const cp = legacyStoreAdapter(store);
  await cp.append("s", [userEvt("a")]);
  await cp.append("s", [userEvt("b")]);
  // the wrapped store holds the folded messages
  expect(await store.load("s")).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
  // read replays them as synthetic events that fold back to the same messages
  const events = [];
  for await (const e of cp.read("s")) events.push(e.event);
  expect(foldEvents(events)).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
  expect(await cp.head("s")).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test -- --run legacy-store-adapter`
Expected: FAIL — `legacyStoreAdapter` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/core/src/checkpoint.ts`:
```ts
import type { Store } from "./strategies";

/**
 * Wrap a legacy whole-array `Store` as a `Checkpointer`, so code that injected a
 * custom Store keeps working. `append` folds the full state and re-saves it (the
 * original O(n) behavior — no per-event durability); `read` replays the saved
 * messages as synthetic `user`/`assistant` events. `head` is the message count.
 */
export function legacyStoreAdapter(store: Store): Checkpointer {
  const eventsOf = (messages: import("./types").Message[]): SessionEvent[] =>
    messages.map((m) =>
      m.role === "assistant"
        ? { type: "assistant", message: m as import("./types").AssistantMessage }
        : { type: "user", message: m },
    );
  return {
    async append(sessionId, events, expectedHead) {
      const current = (await store.load(sessionId)) ?? [];
      if (expectedHead !== undefined && expectedHead !== current.length)
        throw new CheckpointConflictError(sessionId, expectedHead, current.length);
      const merged = [...current, ...foldEvents(events)];
      await store.save(sessionId, merged);
      return merged.length;
    },
    async *read(sessionId) {
      const messages = (await store.load(sessionId)) ?? [];
      yield* storeEvents(sessionId, 0, eventsOf(messages));
    },
    async head(sessionId) {
      return ((await store.load(sessionId)) ?? []).length;
    },
    async list() {
      return [];
    },
    async delete() {
      /* a bare Store cannot delete; no-op */
    },
  };
}
```

Add to `packages/core/src/index.ts`:
```ts
export { legacyStoreAdapter } from "./checkpoint";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/core test -- --run legacy-store-adapter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/checkpoint.ts packages/core/src/index.ts packages/core/test/legacy-store-adapter.test.ts
git commit -m "feat(core): legacyStoreAdapter bridges Store to Checkpointer"
```

---

## Task 4: Backend conformance suite + fileCheckpointer (core testing + sdk)

**Files:**
- Create: `packages/core/src/testing/checkpointerConformance.ts`, `packages/sdk/src/checkpoint.ts`
- Modify: `packages/core/src/index.ts`, `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/fileCheckpointer.test.ts`

- [ ] **Step 1: Write the conformance suite (shared, no vitest)**

`packages/core/src/testing/checkpointerConformance.ts`:
```ts
import assert from "node:assert/strict";
import type { Checkpointer } from "../checkpoint";

const userEvt = (t: string) => ({ type: "user" as const, message: { role: "user" as const, content: t } });
const drain = async (cp: Checkpointer, id: string, opts?: { sinceSeq?: number }) => {
  const out = [] as number[];
  for await (const e of cp.read(id, opts)) out.push(e.seq);
  return out;
};

/** Behavior every Checkpointer backend must satisfy. Each case throws on failure. */
export const checkpointerConformance: Array<{ name: string; run: (make: () => Checkpointer) => Promise<void> }> = [
  {
    name: "append returns monotonic head and read replays in seq order",
    run: async (make) => {
      const cp = make();
      assert.equal(await cp.head("s"), 0);
      assert.equal(await cp.append("s", [userEvt("a"), userEvt("b")]), 2);
      assert.equal(await cp.append("s", [userEvt("c")]), 3);
      assert.deepEqual(await drain(cp, "s"), [1, 2, 3]);
      assert.equal(await cp.head("s"), 3);
    },
  },
  {
    name: "read sinceSeq yields only later events",
    run: async (make) => {
      const cp = make();
      await cp.append("s", [userEvt("a"), userEvt("b"), userEvt("c")]);
      assert.deepEqual(await drain(cp, "s", { sinceSeq: 1 }), [2, 3]);
    },
  },
  {
    name: "stale expectedHead rejects; correct one succeeds",
    run: async (make) => {
      const cp = make();
      await cp.append("s", [userEvt("a")]);
      await assert.rejects(() => cp.append("s", [userEvt("b")], 0));
      assert.equal(await cp.append("s", [userEvt("b")], 1), 2);
    },
  },
  {
    name: "list reports sessions and delete removes a log",
    run: async (make) => {
      const cp = make();
      await cp.append("s1", [userEvt("a")]);
      await cp.append("s2", [userEvt("b")]);
      assert.deepEqual((await cp.list()).map((i) => i.id).sort(), ["s1", "s2"]);
      await cp.delete("s1");
      assert.deepEqual((await cp.list()).map((i) => i.id), ["s2"]);
      assert.equal(await cp.head("s1"), 0);
    },
  },
  {
    name: "concurrent appends to one session serialize to a contiguous seq range",
    run: async (make) => {
      const cp = make();
      await Promise.all(Array.from({ length: 10 }, (_, i) => cp.append("s", [userEvt(`e${i}`)])));
      assert.deepEqual(await drain(cp, "s"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    },
  },
  {
    name: "event payloads round-trip through read",
    run: async (make) => {
      const cp = make();
      await cp.append("s", [userEvt("hello")]);
      const out = [];
      for await (const e of cp.read("s")) out.push(e.event);
      assert.deepEqual(out, [userEvt("hello")]);
    },
  },
];
```

Add to `packages/core/src/index.ts`:
```ts
export { checkpointerConformance } from "./testing/checkpointerConformance";
```

- [ ] **Step 2: Write the failing test for fileCheckpointer**

`packages/sdk/test/fileCheckpointer.test.ts`:
```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointerConformance } from "@lite-agent/core";
import { fileCheckpointer } from "../src/checkpoint";

for (const c of checkpointerConformance) {
  test(`fileCheckpointer: ${c.name}`, async () => {
    await c.run(() => fileCheckpointer({ dir: mkdtempSync(join(tmpdir(), "fc-")) }));
  });
}

test("fileCheckpointer survives a fresh instance over the same dir (durable)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-"));
  const a = fileCheckpointer({ dir });
  await a.append("s", [{ type: "user", message: { role: "user", content: "hi" } }]);
  const b = fileCheckpointer({ dir }); // new process/instance
  expect(await b.head("s")).toBe(1);
  const seen: number[] = [];
  for await (const e of b.read("s")) seen.push(e.seq);
  expect(seen).toEqual([1]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test -- --run fileCheckpointer`
Expected: FAIL — `../src/checkpoint` (fileCheckpointer) not found. (Core must be rebuilt first so the sdk test imports the new conformance export from built `dist`.)

- [ ] **Step 4: Write minimal implementation**

`packages/sdk/src/checkpoint.ts`:
```ts
import { mkdirSync, readFileSync, existsSync, appendFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Checkpointer, SessionEvent, StoredEvent, SessionInfo } from "@lite-agent/core";
import { storeEvents, CheckpointConflictError } from "@lite-agent/core";

export interface FileCheckpointerOptions {
  /** Directory holding one append-only `<sessionId>.jsonl` event log per session. */
  dir: string;
}

const SUFFIX = ".jsonl";
const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Append-only file Checkpointer: one `StoredEvent` per line. Head is cached in
 * memory (read from disk on first touch). Suitable for single-process/local use;
 * cross-process concurrency is the SQLite backend's job.
 */
export function fileCheckpointer(opts: FileCheckpointerOptions): Checkpointer {
  const heads = new Map<string, number>();
  const fileFor = (id: string) => join(opts.dir, sanitize(id) + SUFFIX);
  const linesOf = (id: string): StoredEvent[] => {
    const file = fileFor(id);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as StoredEvent);
  };
  const headOf = (id: string): number => {
    const cached = heads.get(id);
    if (cached !== undefined) return cached;
    const lines = linesOf(id);
    const head = lines.length ? lines[lines.length - 1]!.seq : 0;
    heads.set(id, head);
    return head;
  };
  return {
    async append(sessionId, events, expectedHead) {
      const head = headOf(sessionId);
      if (expectedHead !== undefined && expectedHead !== head)
        throw new CheckpointConflictError(sessionId, expectedHead, head);
      const stored = storeEvents(sessionId, head, events);
      mkdirSync(opts.dir, { recursive: true });
      appendFileSync(fileFor(sessionId), stored.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const newHead = stored.length ? stored[stored.length - 1]!.seq : head;
      heads.set(sessionId, newHead);
      return newHead;
    },
    async *read(sessionId, opts2) {
      for (const e of linesOf(sessionId)) if (opts2?.sinceSeq === undefined || e.seq > opts2.sinceSeq) yield e;
    },
    async head(sessionId) {
      return headOf(sessionId);
    },
    async list(): Promise<SessionInfo[]> {
      if (!existsSync(opts.dir)) return [];
      return readdirSync(opts.dir)
        .filter((f) => f.endsWith(SUFFIX))
        .map((f) => ({ id: f.slice(0, -SUFFIX.length), mtime: statSync(join(opts.dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    },
    async delete(sessionId) {
      const file = fileFor(sessionId);
      if (existsSync(file)) unlinkSync(file);
      heads.delete(sessionId);
    },
  };
}
```
> Note: the concurrent-appends conformance case passes because each `append` runs to completion synchronously (sync fs calls) inside its microtask, so the shared `heads` cache stays consistent within one process.

Add to `packages/sdk/src/index.ts`:
```ts
export { fileCheckpointer } from "./checkpoint";
export type { FileCheckpointerOptions } from "./checkpoint";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test -- --run fileCheckpointer`
Expected: PASS (6 conformance + 1 durability).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/testing/checkpointerConformance.ts packages/core/src/index.ts packages/sdk/src/checkpoint.ts packages/sdk/src/index.ts packages/sdk/test/fileCheckpointer.test.ts
git commit -m "feat: checkpointer conformance suite + fileCheckpointer backend"
```

---

## Task 5: Kernel + createAgent integration (core)

**Files:**
- Modify: `packages/core/src/kernel.ts`, `packages/core/src/createAgent.ts`
- Test: `packages/core/test/kernel-checkpoint.test.ts`

**Context:** Today the kernel uses `cfg.store` (`Store`): it loads the whole array and calls `store.save(sessionId, messages)` once per turn (after the tool pool) and once at the end (`packages/core/src/kernel.ts`). This task switches the seam to `cfg.checkpointer` (`Checkpointer`), loading via `read`+`foldEvents` and appending `user`/`assistant`/`tool_result` events. Appends are serialized through a promise chain so concurrent in-turn `tool_result` appends don't race the head.

- [ ] **Step 1: Write the failing test**

`packages/core/test/kernel-checkpoint.test.ts`:
```ts
import { expect, test } from "vitest";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { noopSandbox } from "../src/sandbox";
import { memoryCheckpointer, foldEvents } from "../src/checkpoint";
import { defineTool } from "../src/tools/define";
import { textBlock } from "../src/types";
import { z } from "zod";
import type { ModelProvider } from "../src/strategies";
import type { AgentEvent, RunResult } from "../src/events";

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: { id: "x", async *stream() {} }, codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
}
const run = async (gen: AsyncGenerator<AgentEvent, RunResult>) => { let r = await gen.next(); while (!r.done) r = await gen.next(); return r.value; };
const echo = defineTool({ name: "echo", description: "echo", schema: z.object({ v: z.string() }), execute: async ({ v }) => v });

test("a run appends user, assistant, and one tool_result event per call", async () => {
  const cp = memoryCheckpointer();
  const fp: ModelProvider = {
    id: "fp",
    async *stream() {
      const turn = i++;
      if (turn === 0) {
        yield { type: "message_done", message: { role: "assistant", content: [
          { type: "tool_call", id: "t1", name: "echo", input: { v: "A" } },
          { type: "tool_call", id: "t2", name: "echo", input: { v: "B" } },
        ] }, usage: { inputTokens: 0, outputTokens: 0 } };
      } else {
        yield { type: "message_done", message: { role: "assistant", content: [textBlock("done")] }, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    },
  };
  let i = 0;
  await run(runKernel(baseCfg({ provider: fp, tools: [echo], checkpointer: cp }), "hi", new AbortController().signal, "s"));
  const types: string[] = [];
  for await (const e of cp.read("s")) types.push(e.event.type);
  // user(hi), assistant(2 tool_calls), tool_result x2, assistant(done)
  expect(types).toEqual(["user", "assistant", "tool_result", "tool_result", "assistant"]);
});

test("resume replays the log so the model sees prior context", async () => {
  const cp = memoryCheckpointer();
  const seen: string[] = [];
  const recorder: ModelProvider = {
    id: "rec",
    async *stream(req) {
      seen.push(JSON.stringify(req.messages));
      yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  await run(runKernel(baseCfg({ provider: recorder, checkpointer: cp }), "first", new AbortController().signal, "s"));
  await run(runKernel(baseCfg({ provider: recorder, checkpointer: cp }), "second", new AbortController().signal, "s"));
  // the second run's request includes the first turn's user+assistant
  expect(seen[1]).toContain("first");
  expect(seen[1]).toContain("ok");
  expect(seen[1]).toContain("second");
  // and the persisted log folds to the full conversation
  const events = [];
  for await (const e of cp.read("s")) events.push(e.event);
  expect(foldEvents(events).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test -- --run kernel-checkpoint`
Expected: FAIL — `KernelConfig` has no `checkpointer`.

- [ ] **Step 3: Implement — kernel**

In `packages/core/src/kernel.ts`:

Update the type import line to add the checkpoint types:
```ts
import type { Checkpointer, SessionEvent, StoredEvent } from "./checkpoint";
import { foldEvents } from "./checkpoint";
```
Replace `store?: Store;` in `KernelConfig` with:
```ts
  checkpointer?: Checkpointer;
```
(and remove the now-unused `Store` from the strategies import on line 1).

Replace the load/persist block (currently lines ~32-37):
```ts
  const inputMessages: Message[] = typeof input === "string" ? [{ role: "user", content: input }] : [...input];
  let messages: Message[] = inputMessages;
  const cp = cfg.checkpointer;
  let head = 0;
  if (cp) {
    const stored: StoredEvent[] = [];
    for await (const e of cp.read(sessionId)) stored.push(e);
    messages = [...foldEvents(stored.map((s) => s.event)), ...inputMessages];
    head = stored.length ? stored[stored.length - 1]!.seq : 0;
  }
  // Serialize appends so concurrent in-turn tool_result appends can't race `head`.
  let chain: Promise<void> = Promise.resolve();
  const append = (...evs: SessionEvent[]): Promise<void> => {
    if (!cp || evs.length === 0) return Promise.resolve();
    const p = chain.then(async () => { head = await cp.append(sessionId, evs, head); });
    chain = p.then(() => undefined, () => undefined);
    return p;
  };
```
Delete the old `const persist = async () => {...}` line.

Right after the initial `messages`/`head` setup (before `runLifecycle beforeAgent`), append the input:
```ts
  await append(...inputMessages.map((m): SessionEvent => ({ type: "user", message: m })));
```

After `ctx.messages.push(assistant); yield { type: "message", message: assistant };` (line ~93-94), append the assistant event:
```ts
    await append({ type: "assistant", message: assistant });
```

Inside `runCall`, after `result` is computed (the `try/catch` that assigns `result`) and before `return { events, result }`, append the tool_result event:
```ts
    await append({ type: "tool_result", result: toolResultBlock(result.id, result.content, result.isError), turn });
```
> `runCall` needs `turn` in scope — it is (the `for` loop variable). `toolResultBlock` is already imported in kernel.ts.

In the post-pool flush loop, **remove** the old `ctx.messages.push({ role: "user", content: resultBlocks }); await persist();` → keep the `ctx.messages.push(...)` (in-memory state for the next turn) but delete `await persist();`. The results are already persisted per-call.

Delete the final `await persist();` near the end (the result is already fully persisted via appends).

- [ ] **Step 4: Implement — createAgent**

In `packages/core/src/createAgent.ts`:
- Add imports: `import type { Checkpointer } from "./checkpoint";` and `import { legacyStoreAdapter } from "./checkpoint";`
- In `CreateAgentConfig`, replace `store?: Store;` with:
```ts
  checkpointer?: Checkpointer;
  /** @deprecated pass `checkpointer`. A legacy Store is adapted automatically. */
  store?: Store;
```
- In the `kernelCfg` literal, replace `store: cfg.store,` with:
```ts
    checkpointer: cfg.checkpointer ?? (cfg.store ? legacyStoreAdapter(cfg.store) : undefined),
```

- [ ] **Step 5: Fix existing kernel tests that passed `store`**

Run: `pnpm --filter @lite-agent/core test 2>&1 | grep -i "store"`
For each failure where a test constructed `KernelConfig`/`createAgent` with `store: memoryStore()` expecting load/save, switch the expectation to `checkpointer: memoryCheckpointer()` (or `store:` still works via createAgent's adapter — but `KernelConfig` no longer has `store`, so direct `runKernel` callers must use `checkpointer`). Update `packages/core/test/store.test.ts` accordingly (it exercises persistence through the kernel): replace its `store` wiring with `checkpointer: memoryCheckpointer()` and assert via `cp.read`/`foldEvents` instead of `store.load`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @lite-agent/core test`
Expected: PASS (existing suite + new kernel-checkpoint tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/kernel.ts packages/core/src/createAgent.ts packages/core/test/
git commit -m "feat(core): kernel persists via event-sourced Checkpointer (per-tool-result durability)"
```

---

## Task 6: SDK wiring + default fileCheckpointer (sdk)

**Files:**
- Modify: `packages/sdk/src/createLiteAgent.ts`, `packages/sdk/src/query.ts`, `packages/sdk/src/store.ts`, `packages/sdk/src/index.ts`, `packages/sdk/src/cleanup.ts`
- Test: `packages/sdk/test/checkpoint-wiring.test.ts`
- Changeset: `.changeset/event-sourced-checkpointer.md`

**Context:** `createLiteAgent` currently defaults `store = cfg.store ?? jsonlStore({ dir: paths.sessionsDir })` and passes `store` to `createAgent`; session management (`deleteSession`/`listSessions`) uses an `isSessionStore` check. Switch the default to `fileCheckpointer`, expose `checkpointer?`, and route session management through the checkpointer. Old whole-array `.jsonl` transcripts are not migrated (per spec §8): they share the `.jsonl` suffix, so `fileCheckpointer.read` would fail to parse old lines as `StoredEvent`. Have the cleanup sweeper delete unpar%-able legacy files so they don't accumulate (see Step 4).

- [ ] **Step 1: Write the failing test**

`packages/sdk/test/checkpoint-wiring.test.ts`:
```ts
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { resolveProjectPaths } from "../src/paths";

const wd = () => mkdtempSync(join(tmpdir(), "cw-"));

test("default persistence writes an event-format log and resumes", async () => {
  const w = wd();
  const fp = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  const agent = createLiteAgent({ model: fp, workdir: w });
  const sid = agent.sessionId;
  const gen = agent.run("hello");
  let g = await gen.next();
  while (!g.done) g = await gen.next();
  const { sessionsDir } = resolveProjectPaths({ workdir: w, home: process.env.LITE_AGENT_HOME! });
  const files = readdirSync(sessionsDir);
  expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);
  const body = readFileSync(join(sessionsDir, `${sid}.jsonl`), "utf8");
  expect(body).toContain('"seq":1'); // StoredEvent shape, not a bare Message
  expect(body).toContain('"type":"user"');
});

test("listSessions/deleteSession work through the checkpointer", async () => {
  const w = wd();
  const fp = fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]);
  const agent = createLiteAgent({ model: fp, workdir: w });
  const sid = agent.sessionId;
  const gen = agent.run("hi");
  let g = await gen.next();
  while (!g.done) g = await gen.next();
  expect((await agent.listSessions()).some((s) => s.id === sid)).toBe(true);
  await agent.deleteSession(sid);
  expect((await agent.listSessions()).some((s) => s.id === sid)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test -- --run checkpoint-wiring`
Expected: FAIL — file is still bare-Message JSONL (no `"seq"`), or `checkpointer` not wired.

- [ ] **Step 3: Implement the wiring**

In `packages/sdk/src/createLiteAgent.ts`:
- Import: `import { fileCheckpointer } from "./checkpoint";` and `import type { Checkpointer } from "@lite-agent/core";`
- In `CreateLiteAgentConfig`, add `checkpointer?: Checkpointer;` (keep `store?: Store;` for back-compat).
- Replace the store selection (`const store = cfg.store ?? (cfg.sessions === false ? undefined : jsonlStore({ dir: paths.sessionsDir }));`) with:
```ts
  const checkpointer: Checkpointer | undefined =
    cfg.checkpointer ??
    (cfg.store ? legacyStoreAdapter(cfg.store) : cfg.sessions === false ? undefined : fileCheckpointer({ dir: paths.sessionsDir }));
```
  (import `legacyStoreAdapter` from `@lite-agent/core`.)
- Pass `checkpointer` (not `store`) into `createAgent({ ... })`.
- Replace the session-management plumbing: drop `isSessionStore`/`sessionStore`; implement `deleteSession`/`listSessions` against `checkpointer`:
```ts
  const noSessions = (): Promise<never> => Promise.reject(new AgentError("session management requires a checkpointer"));
  // ...
  deleteSession: (id: string) => (checkpointer ? checkpointer.delete(id) : noSessions()),
  listSessions: () => (checkpointer ? checkpointer.list() : noSessions()),
```
- In the subagent `spawn` override block (alongside `agents: false`, `onApproval: undefined`, etc.), add `checkpointer: undefined`. Each child then rebuilds its own `fileCheckpointer` from the shared `paths.sessionsDir` (keyed by the child's sessionId) instead of inheriting a parent-supplied checkpointer — preserving today's behavior where subagents persist their own transcripts.

In `packages/sdk/src/query.ts`: add `checkpointer?: Checkpointer;` to `QueryOptions` and pass `checkpointer: opts.checkpointer` into `createLiteAgent`.

In `packages/sdk/src/store.ts`: keep `jsonlStore` (still exported, still a valid `Store`), but change the local `SessionInfo` to a re-export of core's: replace `export interface SessionInfo { ... }` with `export type { SessionInfo } from "@lite-agent/core";` and update `list()`'s return to use it.

In `packages/sdk/src/index.ts`: no removals; `fileCheckpointer` is already exported from Task 4.

- [ ] **Step 4: Old-data discard in the cleanup sweeper**

In `packages/sdk/src/cleanup.ts`, in `sweepStale`, when scanning `sessionsDir`, delete any `.jsonl` whose first non-empty line does not parse to an object with a numeric `seq` (i.e. a legacy whole-array transcript). Add:
```ts
// Discard legacy whole-array transcripts (pre-event-sourcing). Not migrated.
for (const f of readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))) {
  const p = join(sessionsDir, f);
  const first = readFileSync(p, "utf8").split("\n").find((l) => l.trim() !== "");
  if (first) {
    try {
      const o = JSON.parse(first);
      if (typeof o?.seq !== "number") unlinkSync(p);
    } catch {
      unlinkSync(p);
    }
  }
}
```
(guard with `existsSync(sessionsDir)`; import `readFileSync`, `unlinkSync` if missing).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test`
Expected: PASS — incl. checkpoint-wiring; the existing `query forwards sessions:false` and `subagents` tests still pass (subagents persist via their own fileCheckpointer).
> If `subagents.test.ts` asserts a transcript file exists under `sessionsDir`, it still holds — the child writes a `<sid>.jsonl` event log. Update any assertion that read the old bare-Message format to tolerate the StoredEvent format (check the file exists / contains `"type":"assistant"` rather than parsing a bare Message).

- [ ] **Step 6: Add changeset + commit**

`.changeset/event-sourced-checkpointer.md`:
```md
---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

Event-sourced checkpoint persistence

The session store is now an append-only, event-sourced `Checkpointer`: a per-session
log of `SessionEvent`s keyed by a monotonic `seq`, folded back into messages on load
(`foldEvents`). The kernel appends `user`/`assistant`/`tool_result` events as they
occur — each tool result is persisted the moment it completes, closing the mid-turn
data-loss window under concurrent tool execution. New API: `Checkpointer`,
`memoryCheckpointer`, `fileCheckpointer` (the new default), `legacyStoreAdapter`,
`foldEvents`, `CheckpointConflictError`, plus optimistic multi-client concurrency via
`expectedHead`. The legacy `Store` (`jsonlStore`/`memoryStore`) still works via
`legacyStoreAdapter`. Old whole-array transcripts are not migrated and are swept on
cleanup.
```

```bash
git add packages/sdk .changeset/event-sourced-checkpointer.md
git commit -m "feat(sdk): default to fileCheckpointer; session mgmt via Checkpointer"
```

---

## Task 7: `@lite-agent/checkpoint-sqlite` package

**Files:**
- Create: `packages/checkpoint-sqlite/package.json`, `tsup.config.ts`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`, `test/sqlite.test.ts`
- Modify: `.changeset/config.json` (add to fixed group)
- Changeset: `.changeset/checkpoint-sqlite.md`

**Context:** Mirror an existing leaf package for config. Copy `packages/sandbox-anthropic/{tsup.config.ts,tsconfig.json,tsconfig.build.json}` verbatim (same build setup), changing only the package name.

- [ ] **Step 1: Scaffold the package**

`packages/checkpoint-sqlite/package.json`:
```json
{
  "name": "@lite-agent/checkpoint-sqlite",
  "version": "0.4.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@lite-agent/core": "workspace:*", "better-sqlite3": "^11.8.0" },
  "devDependencies": { "@types/better-sqlite3": "^7.6.11" }
}
```
Copy `tsup.config.ts`, `tsconfig.json`, `tsconfig.build.json` from `packages/sandbox-anthropic/` unchanged.

- [ ] **Step 2: Write the failing test**

`packages/checkpoint-sqlite/test/sqlite.test.ts`:
```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointerConformance } from "@lite-agent/core";
import { sqliteCheckpointer } from "../src/index";

const dbFile = () => join(mkdtempSync(join(tmpdir(), "sq-")), "ckpt.db");

for (const c of checkpointerConformance) {
  test(`sqliteCheckpointer: ${c.name}`, async () => {
    await c.run(() => sqliteCheckpointer({ file: dbFile() }));
  });
}

test("durable across reopen of the same file", async () => {
  const file = dbFile();
  const a = sqliteCheckpointer({ file });
  await a.append("s", [{ type: "user", message: { role: "user", content: "hi" } }]);
  a.close();
  const b = sqliteCheckpointer({ file });
  expect(await b.head("s")).toBe(1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core build && pnpm install && pnpm --filter @lite-agent/checkpoint-sqlite test`
Expected: FAIL — `../src/index` not found.

- [ ] **Step 4: Implement the SQLite backend**

`packages/checkpoint-sqlite/src/index.ts`:
```ts
import Database from "better-sqlite3";
import type { Checkpointer, SessionEvent, StoredEvent, SessionInfo } from "@lite-agent/core";
import { CheckpointConflictError } from "@lite-agent/core";

export interface SqliteCheckpointerOptions {
  /** Path to the SQLite database file. Use ":memory:" for an ephemeral DB. */
  file: string;
}

export interface SqliteCheckpointer extends Checkpointer {
  close(): void;
}

export function sqliteCheckpointer(opts: SqliteCheckpointerOptions): SqliteCheckpointer {
  const db = new Database(opts.file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, parent_seq INTEGER,
      ts TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq));
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, updated TEXT NOT NULL, head INTEGER NOT NULL);
  `);

  const headStmt = db.prepare<[string]>("SELECT head FROM sessions WHERE id = ?");
  const insertEvt = db.prepare(
    "INSERT INTO events (session_id, seq, parent_seq, ts, payload) VALUES (?, ?, ?, ?, ?)",
  );
  const upsertSession = db.prepare(
    "INSERT INTO sessions (id, updated, head) VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, head = excluded.head",
  );

  const headOf = (id: string): number => (headStmt.get(id) as { head: number } | undefined)?.head ?? 0;

  const appendTxn = db.transaction((id: string, events: SessionEvent[], expectedHead?: number): number => {
    const head = headOf(id);
    if (expectedHead !== undefined && expectedHead !== head)
      throw new CheckpointConflictError(id, expectedHead, head);
    const ts = new Date().toISOString();
    let seq = head;
    for (const event of events) {
      seq++;
      insertEvt.run(id, seq, seq === 1 ? null : seq - 1, ts, JSON.stringify(event));
    }
    upsertSession.run(id, ts, seq);
    return seq;
  });

  return {
    async append(sessionId, events, expectedHead) {
      return appendTxn(sessionId, events, expectedHead);
    },
    async *read(sessionId, opts2) {
      const rows = db
        .prepare<[string, number]>(
          "SELECT seq, parent_seq, ts, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
        )
        .all(sessionId, opts2?.sinceSeq ?? 0) as Array<{ seq: number; parent_seq: number | null; ts: string; payload: string }>;
      for (const r of rows) {
        const e: StoredEvent = { seq: r.seq, sessionId, parentSeq: r.parent_seq, ts: r.ts, event: JSON.parse(r.payload) as SessionEvent };
        yield e;
      }
    },
    async head(sessionId) {
      return headOf(sessionId);
    },
    async list(): Promise<SessionInfo[]> {
      const rows = db.prepare("SELECT id, updated FROM sessions ORDER BY updated DESC").all() as Array<{ id: string; updated: string }>;
      return rows.map((r) => ({ id: r.id, mtime: Date.parse(r.updated) }));
    },
    async delete(sessionId) {
      db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    },
    close() {
      db.close();
    },
  };
}
```
> `better-sqlite3` is synchronous, so `appendTxn` is atomic and `BEGIN IMMEDIATE`-equivalent under WAL; the concurrent-append conformance case passes because each transaction commits before the next runs.

- [ ] **Step 5: Add the package to the changeset fixed group**

In `.changeset/config.json`, add `"@lite-agent/checkpoint-sqlite"` to the existing `fixed` array (the group that already holds `lite-agent` + `@lite-agent/{core,provider,sandbox-anthropic}`).

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm install && pnpm --filter @lite-agent/checkpoint-sqlite build && pnpm --filter @lite-agent/checkpoint-sqlite test`
Expected: PASS (6 conformance + 1 durability).

- [ ] **Step 7: Add changeset + commit**

`.changeset/checkpoint-sqlite.md`:
```md
---
"@lite-agent/checkpoint-sqlite": minor
---

New package: a SQLite (WAL) Checkpointer backend for single-host multi-process persistence. `sqliteCheckpointer({ file })` passes the shared checkpointer conformance suite.
```

```bash
git add packages/checkpoint-sqlite .changeset/config.json .changeset/checkpoint-sqlite.md
git commit -m "feat: @lite-agent/checkpoint-sqlite backend"
```

---

## Final verification

- [ ] **Full monorepo check**

Run: `pnpm -r build && pnpm -r test && pnpm -r typecheck`
Expected: all packages build, all tests pass, typecheck clean. The SQLite package builds its native dep on install.

- [ ] **Dispatch the final whole-branch code review** (per subagent-driven-development), then `superpowers:finishing-a-development-branch`.

---

## Self-review notes (spec coverage)

- Spec §3 (Checkpointer interface) → Task 2. §4 (data model) → Task 1 (compaction event dropped — see the Deviation note above). §5 (kernel integration / when written) → Task 5. §6 (concurrency: monotonic seq, optimistic `expectedHead`, SQLite WAL) → Tasks 2/4/7. §7 (backends + conformance suite) → Tasks 4/7. §8 (no migration; sweep old data) → Task 6 Step 4. §9 (error handling; mid-turn re-run deferred) → Tasks 2/5 (re-run stays deferred, as the spec states). §10 (testing) → conformance suite + per-task tests. §11 future work (B/C/server/Postgres) → out of scope, untouched.
- **Deferred within A (spec §9):** re-running missing tool calls on resume. The MVP guarantees correct replay; a trailing assistant with unmatched tool_calls replays as-is (the next run continues from there).
