# Plan 1 — Session Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a consumer of the stateful `createLiteAgent` agent roll a session back to an earlier checkpoint — reverting conversation (log truncation) and/or files changed via `write_file`/`edit_file` (from pre-mutation snapshots) — mirroring Claude Code's `/rewind`, with the same limitation that `bash`-made changes are not tracked.

**Architecture:** A new sidecar `SessionEvent` `file_snapshot` records a file's pre-mutation content on the existing per-session event log. `foldEvents` is made type-aware so sidecar events never reach the model context. The kernel hands file-mutating tools an optional `ctx.recordSnapshot` (wired to its serialized `append`, so the snapshot lands before the tool's `tool_result`). `Checkpointer` gains an optional `truncate`. `LiteAgent` gains `listCheckpoints` and `restore`.

**Tech Stack:** TypeScript 6 (ESM, `verbatimModuleSyntax`), pnpm workspace, vitest. No new dependencies.

---

## Decisions / context

- Spec: `docs/superpowers/specs/2026-06-30-session-time-travel-design.md`.
- Branch: create `feat/session-time-travel` off `main` (B-1/B-2 already merged & released at 0.6.0). Do **all** of Plan 1 and Plan 2 on this one branch.
- Commit convention: conventional-commit subject, **no** Claude/Co-Authored-By trailer.
- Build choreography: packages import each other via built `dist/`. Rebuild a changed package before testing a dependent. core's own tests run against `src`.
- `foldEvents`, `memoryCheckpointer`, `storeEvents`, `Checkpointer`, `SessionEvent`, `StoredEvent` are already exported from `@lite-agent/core`.

## File structure

- `packages/core/src/checkpoint.ts` — `file_snapshot` variant; type-aware `foldEvents`; `Checkpointer.truncate?`; `memoryCheckpointer.truncate`.
- `packages/core/src/strategies.ts` — `ToolContext.recordSnapshot?`.
- `packages/core/src/kernel.ts` — provide `recordSnapshot` to tool execution.
- `packages/sdk/src/checkpoint.ts` — `fileCheckpointer.truncate`.
- `packages/checkpoint-sqlite/src/index.ts` — sqlite `truncate`.
- `packages/sdk/src/tools/file.ts` — snapshot before mutating in `write_file`/`edit_file`.
- `packages/sdk/src/createLiteAgent.ts` — `listCheckpoints`, `restore`.
- Tests alongside each.

---

### Task 1: `file_snapshot` event + sidecar-aware `foldEvents`

**Files:** `packages/core/src/checkpoint.ts`, test `packages/core/test/checkpoint-fold.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `packages/core/test/checkpoint-fold.test.ts`:

```ts
import { test, expect } from "vitest";
import { foldEvents } from "../src/checkpoint";
import type { SessionEvent } from "../src/checkpoint";

test("foldEvents skips file_snapshot sidecar events", () => {
  const events: SessionEvent[] = [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "file_snapshot", path: "a.txt", before: null, turn: 1 },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ];
  expect(foldEvents(events)).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
});
```

- [ ] **Step 2: Run → FAIL** (type error / unexpected message). Run: `pnpm --filter @lite-agent/core test -- checkpoint-fold`

- [ ] **Step 3: Implement.** In `packages/core/src/checkpoint.ts`, extend the `SessionEvent` union (add the `file_snapshot` line after `tool_result`):

```ts
export type SessionEvent =
  | { type: "user"; message: Message }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "tool_result"; result: ToolResultBlock; turn: number }
  | { type: "file_snapshot"; path: string; before: string | null; truncated?: boolean; turn: number };
```

Replace the body of `foldEvents` with a type-aware switch (skips any sidecar/unknown event):

```ts
export function foldEvents(events: SessionEvent[]): Message[] {
  let messages: Message[] = [];
  let pending: ToolResultBlock[] = [];
  const flush = () => {
    if (pending.length) { messages.push({ role: "user", content: pending }); pending = []; }
  };
  for (const ev of events) {
    switch (ev.type) {
      case "tool_result": pending.push(ev.result); break;
      case "user": case "assistant": flush(); messages.push(ev.message); break;
      // file_snapshot (and future sidecar events): not part of model context
    }
  }
  flush();
  return messages;
}
```

- [ ] **Step 4: Run → PASS** + full core suite green: `pnpm --filter @lite-agent/core test`. Typecheck: `pnpm --filter @lite-agent/core typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/checkpoint.ts packages/core/test/checkpoint-fold.test.ts
git commit -m "feat(core): file_snapshot sidecar event + type-aware foldEvents"
```

---

### Task 2: `Checkpointer.truncate?` + `memoryCheckpointer`

**Files:** `packages/core/src/checkpoint.ts`, test `packages/core/test/checkpoint-memory.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `packages/core/test/checkpoint-memory.test.ts`:

```ts
test("memoryCheckpointer.truncate drops events past toSeq", async () => {
  const cp = memoryCheckpointer();
  await cp.append("s", [
    { type: "user", message: { role: "user", content: "a" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    { type: "user", message: { role: "user", content: "c" } },
  ]);
  await cp.truncate!("s", 2);
  const seen: number[] = [];
  for await (const e of cp.read("s")) seen.push(e.seq);
  expect(seen).toEqual([1, 2]);
  expect(await cp.head("s")).toBe(2);
});
```
> If `memoryCheckpointer` isn't imported in this file yet, add `import { memoryCheckpointer } from "../src/checkpoint";` at the top.

- [ ] **Step 2: Run → FAIL** (`truncate` undefined). Run: `pnpm --filter @lite-agent/core test -- checkpoint-memory`

- [ ] **Step 3: Implement.** In `packages/core/src/checkpoint.ts`, add to the `Checkpointer` interface (after `delete`):

```ts
  /** Drop every event with seq > toSeq. Optional: backends that cannot truncate omit it. */
  truncate?(sessionId: string, toSeq: number): Promise<void>;
```

Add the method to `memoryCheckpointer`'s returned object (after `delete`):

```ts
    async truncate(sessionId, toSeq) {
      const log = logs.get(sessionId);
      if (!log) return;
      logs.set(sessionId, log.filter((e) => e.seq <= toSeq));
      updated.set(sessionId, Date.now());
    },
```

- [ ] **Step 4: Run → PASS** + full core suite + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/checkpoint.ts packages/core/test/checkpoint-memory.test.ts
git commit -m "feat(core): optional Checkpointer.truncate + memoryCheckpointer impl"
```

---

### Task 3: `fileCheckpointer.truncate` (sdk)

**Files:** `packages/sdk/src/checkpoint.ts`, test `packages/sdk/test/fileCheckpointer.test.ts`

> Rebuild core first so the sdk sees the new interface: `pnpm --filter @lite-agent/core build`.

- [ ] **Step 1: Write the failing test.** Append to `packages/sdk/test/fileCheckpointer.test.ts`:

```ts
test("fileCheckpointer.truncate rewrites the log up to toSeq", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-"));
  const cp = fileCheckpointer({ dir });
  await cp.append("s", [
    { type: "user", message: { role: "user", content: "a" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    { type: "user", message: { role: "user", content: "c" } },
  ]);
  await cp.truncate!("s", 2);
  const seen: number[] = [];
  for await (const e of cp.read("s")) seen.push(e.seq);
  expect(seen).toEqual([1, 2]);
  expect(await cp.head("s")).toBe(2);
  // a fresh instance (cold head cache) must agree
  expect(await fileCheckpointer({ dir }).head("s")).toBe(2);
});
```
> Ensure the file imports `mkdtempSync`, `join`, `tmpdir`, and `fileCheckpointer` — mirror the existing imports already at the top of `fileCheckpointer.test.ts`.

- [ ] **Step 2: Run → FAIL.** Run: `pnpm --filter @lite-agent/sdk test -- fileCheckpointer`

- [ ] **Step 3: Implement.** In `packages/sdk/src/checkpoint.ts`, add (after `delete`, inside the returned object). It needs `writeFileSync`; add it to the `node:fs` import at the top of the file:

```ts
    async truncate(sessionId, toSeq) {
      const kept = linesOf(sessionId).filter((e) => e.seq <= toSeq);
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(
        fileFor(sessionId),
        kept.length ? kept.map((e) => JSON.stringify(e)).join("\n") + "\n" : "",
      );
      heads.set(sessionId, kept.length ? kept[kept.length - 1]!.seq : 0);
    },
```
Update the `node:fs` import line to include `writeFileSync`:
```ts
import { mkdirSync, readFileSync, existsSync, appendFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
```

- [ ] **Step 4: Run → PASS.** Typecheck: `pnpm --filter @lite-agent/sdk typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/checkpoint.ts packages/sdk/test/fileCheckpointer.test.ts
git commit -m "feat(sdk): fileCheckpointer.truncate"
```

---

### Task 4: sqlite `truncate` (checkpoint-sqlite)

**Files:** `packages/checkpoint-sqlite/src/index.ts`, test `packages/checkpoint-sqlite/test/<existing>.test.ts`

> Rebuild core first: `pnpm --filter @lite-agent/core build`.

- [ ] **Step 1: Write the failing test.** Add to the existing checkpoint-sqlite test file (mirror its setup — it constructs the checkpointer over an in-memory or temp-file db; reuse that harness):

```ts
test("truncate drops events past toSeq and resets head", async () => {
  const cp = /* construct as the other tests in this file do */;
  await cp.append("s", [
    { type: "user", message: { role: "user", content: "a" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    { type: "user", message: { role: "user", content: "c" } },
  ]);
  await cp.truncate!("s", 2);
  const seen: number[] = [];
  for await (const e of cp.read("s")) seen.push(e.seq);
  expect(seen).toEqual([1, 2]);
  expect(await cp.head("s")).toBe(2);
});
```

- [ ] **Step 2: Run → FAIL.** Run: `pnpm --filter @lite-agent/checkpoint-sqlite test`

- [ ] **Step 3: Implement.** In `packages/checkpoint-sqlite/src/index.ts`, add a prepared statement near the other `db.prepare(...)` calls and a `truncate` method on the returned object. Read the file first to match its exact table/column names (events table, `seq` column, and the `sessions` head-tracking row). The method must, in one transaction: delete events with `seq > toSeq` for the session, then update that session's cached `head` to `min(head, toSeq)` (or the max remaining seq). Example shape (adapt names to the actual schema):

```ts
  const truncateTxn = db.transaction((id: string, toSeq: number) => {
    db.prepare("DELETE FROM events WHERE session_id = ? AND seq > ?").run(id, toSeq);
    const max = db.prepare("SELECT MAX(seq) AS m FROM events WHERE session_id = ?").get(id) as { m: number | null };
    setHead(id, max.m ?? 0); // reuse however this file upserts the sessions head row
  });
  // ...in the returned object:
  async truncate(sessionId, toSeq) { truncateTxn.immediate(sessionId, toSeq); },
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/checkpoint-sqlite/src/index.ts packages/checkpoint-sqlite/test
git commit -m "feat(checkpoint-sqlite): truncate"
```

---

### Task 5: `ToolContext.recordSnapshot?` + kernel wiring

**Files:** `packages/core/src/strategies.ts`, `packages/core/src/kernel.ts`, test `packages/core/test/kernel-checkpoint.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `packages/core/test/kernel-checkpoint.test.ts` (it already constructs kernels with a `memoryCheckpointer` — reuse its helpers/imports):

```ts
test("a tool's recordSnapshot persists a file_snapshot before its tool_result", async () => {
  const cp = memoryCheckpointer();
  const snap = defineTool({
    name: "snap", description: "s", schema: z.object({}),
    execute: (_i, ctx) => { ctx.recordSnapshot?.("f.txt", "OLD"); return "done"; },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "snap", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  await drain(runKernel(baseCfg({ provider, tools: [snap], checkpointer: cp }), "hi", new AbortController().signal, "s1"));
  const types: string[] = [];
  for await (const e of cp.read("s1")) types.push(e.event.type);
  const iSnap = types.indexOf("file_snapshot");
  const iResult = types.indexOf("tool_result");
  expect(iSnap).toBeGreaterThanOrEqual(0);
  expect(iSnap).toBeLessThan(iResult); // snapshot lands before the tool_result
});
```
> Match `baseCfg`/`fakeProvider`/`drain`/`textBlock`/`defineTool`/`z` to how `kernel-checkpoint.test.ts` already imports them (extract/duplicate a tiny inline `baseCfg`/`drain` if the file doesn't have them).

- [ ] **Step 2: Run → FAIL** (`recordSnapshot` undefined → no file_snapshot). Run: `pnpm --filter @lite-agent/core test -- kernel-checkpoint`

- [ ] **Step 3a: Add the field.** In `packages/core/src/strategies.ts`, add to `ToolContext` (after `call`):

```ts
  /** Record a file's pre-mutation content into the session log (for restore). Provided by
   *  the kernel only when a checkpointer is active; file-mutating tools call it before writing. */
  recordSnapshot?(path: string, before: string | null, truncated?: boolean): void;
```

- [ ] **Step 3b: Wire it in the kernel.** In `packages/core/src/kernel.ts`, inside `runCall`, build `recordSnapshot` and pass it to `tool.execute`. The current execute call is:

```ts
          const out = await tool.execute(parsed, { sessionId, signal, emit: callEmit, sandbox: cfg.sandbox, input: cfg.input, call });
```

Just before the `baseExec`/`const baseExec = ...` definition in `runCall`, add:

```ts
      const recordSnapshot = cfg.checkpointer
        ? (path: string, before: string | null, truncated?: boolean) => {
            void append({ type: "file_snapshot", path, before, truncated, turn });
          }
        : undefined;
```

and change the execute call to include it:

```ts
          const out = await tool.execute(parsed, { sessionId, signal, emit: callEmit, sandbox: cfg.sandbox, input: cfg.input, call, recordSnapshot });
```

> `append` (the kernel's serialized checkpoint-append helper) and `turn` are both in scope inside `runCall`. `append` chains writes, so a `file_snapshot` enqueued during `tool.execute` is durably ordered before the `tool_result` appended after `execute` returns.

- [ ] **Step 4: Run → PASS** + full core suite green + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/strategies.ts packages/core/src/kernel.ts packages/core/test/kernel-checkpoint.test.ts
git commit -m "feat(core): ToolContext.recordSnapshot wired through the kernel"
```

---

### Task 6: `write_file`/`edit_file` snapshot before mutating

**Files:** `packages/sdk/src/tools/file.ts`, test `packages/sdk/test/file.test.ts`

> Rebuild core first: `pnpm --filter @lite-agent/core build`.

- [ ] **Step 1: Write the failing test.** Append to `packages/sdk/test/file.test.ts`:

```ts
test("write_file/edit_file record pre-mutation snapshots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-snap-"));
  const [read, write, edit] = fileTools(dir);
  const snaps: { p: string; b: string | null; t?: boolean }[] = [];
  const snapCtx: ToolContext = { ...ctx, recordSnapshot: (p, b, t) => snaps.push({ p, b, t }) };

  await write!.execute({ path: "n.txt", content: "v1" }, snapCtx); // new file → before null
  await edit!.execute({ path: "n.txt", old_text: "v1", new_text: "v2" }, snapCtx); // → before "v1"

  expect(snaps).toEqual([
    { p: "n.txt", b: null, t: undefined },
    { p: "n.txt", b: "v1", t: undefined },
  ]);
});
```
> `ctx` and `ToolContext` are already imported/defined in `file.test.ts`. `read` is unused here — keep the destructure or prefix with `_`.

- [ ] **Step 2: Run → FAIL.** Run: `pnpm --filter @lite-agent/sdk test -- file`

- [ ] **Step 3: Implement.** In `packages/sdk/src/tools/file.ts`:

Update the `node:fs` import to add `existsSync`, `statSync`:
```ts
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
```
Add a constant near `MAX_BYTES`:
```ts
const MAX_SNAPSHOT_BYTES = 1_000_000;
```
In `write_file`'s `execute`, before `mkdirSync(...)`:
```ts
      const fp = safePath(path);
      if (ctx.recordSnapshot) {
        if (!existsSync(fp)) ctx.recordSnapshot(path, null);
        else if (statSync(fp).size > MAX_SNAPSHOT_BYTES) ctx.recordSnapshot(path, null, true);
        else ctx.recordSnapshot(path, readFileSync(fp, "utf8"));
      }
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
```
(Replace the existing `const fp = safePath(path); mkdirSync(...); writeFileSync(...)` with the block above — note `execute` must now take `(args, ctx)`.)

In `edit_file`'s `execute`, after the `content.includes` guard and before the write (reuse the already-read `content`):
```ts
      if (ctx.recordSnapshot) {
        if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) ctx.recordSnapshot(path, null, true);
        else ctx.recordSnapshot(path, content);
      }
      writeFileSync(fp, content.replace(old_text, new_text));
```
(Both `execute` signatures change from `({ ... })` to `({ ... }, ctx)`.)

- [ ] **Step 4: Run → PASS** (the new test + the existing `read/write/edit operate within the workspace` test, which passes a `ctx` without `recordSnapshot` — the guard makes snapshotting a no-op there). Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tools/file.ts packages/sdk/test/file.test.ts
git commit -m "feat(sdk): snapshot prior file content in write_file/edit_file"
```

---

### Task 7: `listCheckpoints` + `restore` on `LiteAgent`

**Files:** `packages/sdk/src/createLiteAgent.ts`, test `packages/sdk/test/restore.test.ts` (new)

> Rebuild core first: `pnpm --filter @lite-agent/core build`.

- [ ] **Step 1: Write the failing test.** Create `packages/sdk/test/restore.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock, memoryCheckpointer } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

test("restore reverts a file written via write_file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-restore-"));
  const cp = memoryCheckpointer();
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "write_file", input: { path: "f.txt", content: "v1" } }] } },
      { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    workdir: dir, checkpointer: cp, sessions: false === false ? undefined : undefined, // keep checkpointer explicit
  });
  const id = agent.sessionId;
  await agent.send("write it");
  expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("v1");

  // roll back to before any work (seq 0): file is removed
  await agent.restore(id, 0, { files: true, conversation: false });
  expect(existsSync(join(dir, "f.txt"))).toBe(false);
});

test("restore can truncate the conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-restore2-"));
  const cp = memoryCheckpointer();
  const agent = createLiteAgent({
    model: fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]),
    workdir: dir, checkpointer: cp,
  });
  const id = agent.sessionId;
  await agent.send("first");
  const cps = await agent.listCheckpoints(id);
  expect(cps.length).toBe(1);
  expect(cps[0]!.prompt).toBe("first");

  await agent.restore(id, 1, { conversation: true, files: false }); // keep only seq 1
  const seen: number[] = [];
  for await (const e of cp.read(id)) seen.push(e.seq);
  expect(seen).toEqual([1]);
});
```
> The `sessions:` line above is noise — delete it; pass only `{ model, workdir: dir, checkpointer: cp }`. (An explicit `checkpointer` already enables sessions.)

- [ ] **Step 2: Run → FAIL** (`restore`/`listCheckpoints` not functions). Run: `pnpm --filter @lite-agent/sdk test -- restore`

- [ ] **Step 3a: Update the `LiteAgent` interface.** In `packages/sdk/src/createLiteAgent.ts`, add to the `LiteAgent` interface (after `listSessions`):

```ts
  /** List the rewind anchors (one per user prompt) for a session, oldest-first. */
  listCheckpoints(id: string): Promise<{ seq: number; prompt: string; ts: string }[]>;
  /** Roll a session back to checkpoint `toSeq`: revert files snapshotted after it and/or
   *  truncate the conversation. Both default true. Sets the current session to `id`. */
  restore(id: string, toSeq: number, opts?: { conversation?: boolean; files?: boolean }): Promise<void>;
```

- [ ] **Step 3b: Add imports.** At the top of `createLiteAgent.ts`, add to the `node:fs` import (create it if absent) `existsSync, writeFileSync, unlinkSync`, and import `makeSafePath`:

```ts
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { makeSafePath } from "./tools/file";
```

- [ ] **Step 3c: Implement the methods** in the returned object (after `listSessions`):

```ts
    listCheckpoints: async (id: string) => {
      if (!checkpointer) return noSessions();
      const out: { seq: number; prompt: string; ts: string }[] = [];
      for await (const e of checkpointer.read(id)) {
        if (e.event.type === "user" && typeof e.event.message.content === "string") {
          out.push({ seq: e.seq, prompt: e.event.message.content, ts: e.ts });
        }
      }
      return out;
    },
    restore: async (id: string, toSeq: number, opts?: { conversation?: boolean; files?: boolean }) => {
      if (!checkpointer) return noSessions();
      const files = opts?.files ?? true;
      const conversation = opts?.conversation ?? true;
      if (files) {
        const safe = makeSafePath(cfg.workdir);
        const earliest = new Map<string, { before: string | null; truncated?: boolean }>();
        for await (const e of checkpointer.read(id, { sinceSeq: toSeq })) {
          if (e.event.type === "file_snapshot" && !earliest.has(e.event.path)) {
            earliest.set(e.event.path, { before: e.event.before, truncated: e.event.truncated });
          }
        }
        for (const [path, snap] of earliest) {
          if (snap.truncated) continue; // non-restorable; leave current content untouched
          const fp = safe(path);
          if (snap.before === null) { if (existsSync(fp)) unlinkSync(fp); }
          else writeFileSync(fp, snap.before);
        }
      }
      if (conversation) {
        if (!checkpointer.truncate)
          throw new AgentError("conversation restore requires a checkpointer that supports truncate");
        await checkpointer.truncate(id, toSeq);
      }
      currentSessionId = id;
    },
```
> `AgentError` is already imported in this file (used by `noSessions`). `currentSessionId` and `checkpointer` are in scope.

- [ ] **Step 4: Run → PASS** + full sdk suite green + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/createLiteAgent.ts packages/sdk/test/restore.test.ts
git commit -m "feat(sdk): listCheckpoints + restore (files + conversation) on LiteAgent"
```

---

### Task 8: Full gate + changeset

**Files:** `.changeset/session-restore.md`

- [ ] **Step 1: Full gate** — `pnpm -r build && pnpm -r test && pnpm -r typecheck`. All green incl. `examples/cli`.

- [ ] **Step 2: Changeset** — `.changeset/session-restore.md`:

```markdown
---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
"@lite-agent/checkpoint-sqlite": minor
---

Add session restore. A new `file_snapshot` sidecar event records the pre-mutation content of files changed via `write_file`/`edit_file`; `LiteAgent.restore(id, toSeq, { conversation?, files? })` rolls a session back to a checkpoint — reverting those files and/or truncating the conversation — and `listCheckpoints(id)` enumerates the rewind anchors. `Checkpointer` gains an optional `truncate`. Like Claude Code, files changed by `bash` are not tracked.
```
> Note: `checkpoint-sqlite` is intentionally bumped here (it gained `truncate`). If `pnpm run publish-version` later cascades it differently than intended, reconcile at version time.

- [ ] **Step 3: Commit**

```bash
git add .changeset/session-restore.md
git commit -m "chore: changeset for session restore"
```

---

## Self-Review

- **Spec coverage:** `file_snapshot` + fold (T1), `truncate` across all three backends (T2–T4), `recordSnapshot` seam + kernel wiring (T5), tool snapshotting + size cap (T6), `listCheckpoints`/`restore` API (T7), packaging (T8).
- **Inert when unused:** with no checkpointer, `recordSnapshot` is undefined → tools skip; `foldEvents` change is a pure refactor (same output for existing event types). Every existing test should stay green.
- **Ordering:** the kernel's serialized `append` guarantees `file_snapshot` precedes its `tool_result`; restore takes the *earliest* snapshot per path after `toSeq` = the state at `toSeq`.
- **bash limitation honored:** only `write_file`/`edit_file` call `recordSnapshot`; bash changes are out of scope by construction.
