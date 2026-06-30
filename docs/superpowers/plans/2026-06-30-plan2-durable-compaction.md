# Plan 2 — Durable Manual Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual `compact()` action to the stateful `LiteAgent` that compresses the current session's conversation, reports progress, persists the compacted view durably, emits a completion notification, then stops — producing no model answer or extra output. Mirrors Claude Code's `/compact`.

**Architecture:** A new sidecar `SessionEvent` `summary` stores a compacted `Message[]` plus the seq it covers. `foldEvents` gains a `summary` case that resets the message base, so loading a session with a summary uses the compacted view **with no kernel change**, while the original events remain on the log (so Plan 1 restore can still un-compact by truncating past the summary). `compact()` reuses the agent's configured `Compactor`, computes token deltas with `estimateTokens`, appends the `summary`, and yields `compaction` progress/notification events.

**Tech Stack:** TypeScript 6 (ESM, `verbatimModuleSyntax`), pnpm workspace, vitest. No new dependencies.

---

## Decisions / context

- Spec: `docs/superpowers/specs/2026-06-30-session-time-travel-design.md`.
- **Depends on Plan 1** for the type-aware `foldEvents` switch (Plan 1 Task 1). Build on the same branch `feat/session-time-travel` after Plan 1 lands.
- Commit convention: conventional-commit subject, **no** Claude/Co-Authored-By trailer.
- Already exported from `@lite-agent/core`: `foldEvents`, `estimateTokens`, `memoryCheckpointer`, `Checkpointer`, `SessionEvent`, `CompactResult`, `Compactor`.
- `compact()` is an **action**: it never runs a model turn or emits an assistant answer. The generator yields progress + a completion notification, then returns.

## File structure

- `packages/core/src/checkpoint.ts` — `summary` variant; `foldEvents` summary case.
- `packages/core/src/events.ts` — `compaction` event `kind` gains `"manual"` + optional `phase`.
- `packages/sdk/src/createLiteAgent.ts` — `compact()` action.
- Tests alongside each.

---

### Task 1: `summary` event + `foldEvents` reset case

**Files:** `packages/core/src/checkpoint.ts`, test `packages/core/test/checkpoint-fold.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `packages/core/test/checkpoint-fold.test.ts`:

```ts
test("foldEvents uses the latest summary as the base, then appends later events", () => {
  const events: SessionEvent[] = [
    { type: "user", message: { role: "user", content: "old-1" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "old-2" }] } },
    { type: "summary", messages: [{ role: "user", content: "SUMMARY" }], throughSeq: 2, before: 100, after: 5 },
    { type: "user", message: { role: "user", content: "new-3" } },
  ];
  expect(foldEvents(events)).toEqual([
    { role: "user", content: "SUMMARY" },
    { role: "user", content: "new-3" },
  ]);
});
```

- [ ] **Step 2: Run → FAIL** (type error / summary treated as nothing). Run: `pnpm --filter @lite-agent/core test -- checkpoint-fold`

- [ ] **Step 3: Implement.** In `packages/core/src/checkpoint.ts`, add the `summary` variant to `SessionEvent` (after `file_snapshot`):

```ts
  | { type: "summary"; messages: Message[]; throughSeq: number; before: number; after: number };
```

Add a `summary` case to the `foldEvents` switch (it replaces the base; clear any pending tool results):

```ts
      case "summary": pending = []; messages = [...ev.messages]; break;
```

- [ ] **Step 4: Run → PASS** + full core suite green + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/checkpoint.ts packages/core/test/checkpoint-fold.test.ts
git commit -m "feat(core): summary sidecar event + foldEvents reset-to-summary"
```

---

### Task 2: `compact()` action on `LiteAgent`

**Files:** `packages/core/src/events.ts`, `packages/sdk/src/createLiteAgent.ts`, test `packages/sdk/test/compact.test.ts` (new)

> Rebuild core first so the sdk sees the new event + summary types: `pnpm --filter @lite-agent/core build`.

- [ ] **Step 1: Write the failing test.** Create `packages/sdk/test/compact.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock, memoryCheckpointer } from "@lite-agent/core";
import type { Message, CompactResult } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

test("compact() compresses, persists a summary, notifies, and stops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-compact-"));
  const cp = memoryCheckpointer();
  const compactor = {
    async maybeCompact(): Promise<CompactResult> {
      return { messages: [{ role: "user", content: "SUMMARY" } as Message] };
    },
  };
  const agent = createLiteAgent({
    model: fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]),
    workdir: dir, checkpointer: cp, compactor,
  });
  const id = agent.sessionId;
  await agent.send("hello there");

  const events = [];
  for await (const e of agent.compact()) events.push(e);

  // progress + completion notification, both compaction events, kind "manual"
  expect(events.every((e) => e.type === "compaction" && e.kind === "manual")).toBe(true);
  expect(events.some((e) => e.type === "compaction" && e.phase === "done")).toBe(true);

  // a summary event was persisted
  const stored = [];
  for await (const e of cp.read(id)) stored.push(e.event);
  expect(stored.some((e) => e.type === "summary")).toBe(true);
  const summary = stored.find((e) => e.type === "summary")!;
  expect(summary).toMatchObject({ type: "summary", messages: [{ role: "user", content: "SUMMARY" }] });
});
```

- [ ] **Step 2: Run → FAIL** (`compact` not a function). Run: `pnpm --filter @lite-agent/sdk test -- compact`

- [ ] **Step 3a: Extend the compaction event.** In `packages/core/src/events.ts`, change the `compaction` variant of `AgentEventBody` to:

```ts
  | { type: "compaction"; kind: "micro" | "auto" | "manual"; before: number; after: number; phase?: "start" | "done" }
```
(The existing in-memory compaction middleware emits without `phase` and with `kind` `"micro"`/`"auto"` — still valid.)

- [ ] **Step 3b: Add the `LiteAgent.compact` signature.** In `packages/sdk/src/createLiteAgent.ts`, add to the `LiteAgent` interface (after `restore` from Plan 1, or after `listSessions` if Plan 1 isn't merged yet):

```ts
  /** Manually compact the current session: compress the conversation, persist the result,
   *  emit progress + a completion notification, then stop. No model answer is produced. */
  compact(): AsyncGenerator<AgentEvent, { before: number; after: number }>;
```

- [ ] **Step 3c: Add imports.** At the top of `createLiteAgent.ts`, ensure `foldEvents` and `estimateTokens` are imported from `@lite-agent/core` (add them to the existing value import from that package):

```ts
// add to the existing `import { ... } from "@lite-agent/core";`
  foldEvents, estimateTokens,
```

- [ ] **Step 3d: Implement `compact`** in the returned object (after `restore`):

```ts
    async *compact() {
      if (!checkpointer) { await noSessions(); return { before: 0, after: 0 }; }
      if (!compactor) throw new AgentError("compact requires a compactor (it is disabled when compactor:false)");
      const id = currentSessionId;
      const stored = [];
      for await (const e of checkpointer.read(id)) stored.push(e);
      const messages = foldEvents(stored.map((s) => s.event));
      const before = estimateTokens(messages);
      yield { type: "compaction", kind: "manual", phase: "start", before, after: before };
      const result = await compactor.maybeCompact(messages, { inputTokens: 0, outputTokens: 0 });
      const after = estimateTokens(result.messages);
      if (result.messages !== messages) {
        const head = stored.length ? stored[stored.length - 1]!.seq : 0;
        await checkpointer.append(
          id,
          [{ type: "summary", messages: result.messages, throughSeq: head, before, after }],
          head,
        );
      }
      yield { type: "compaction", kind: "manual", phase: "done", before, after };
      return { before, after };
    },
```
> `checkpointer`, `compactor`, `currentSessionId`, `noSessions`, `AgentError` are all already in scope in `createLiteAgent`. `compactor` may be falsy when `compactor:false` — the guard handles it.

- [ ] **Step 4: Run → PASS** + full sdk suite + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts packages/sdk/src/createLiteAgent.ts packages/sdk/test/compact.test.ts
git commit -m "feat(sdk): manual compact() action — durable summary + progress/notify, then stop"
```

---

### Task 3: Full gate + changeset

**Files:** `.changeset/durable-compaction.md`

- [ ] **Step 1: Full gate** — `pnpm -r build && pnpm -r test && pnpm -r typecheck`. All green incl. `examples/cli`.

- [ ] **Step 2: Changeset** — `.changeset/durable-compaction.md`:

```markdown
---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

Add a manual, durable compaction action. `LiteAgent.compact()` compresses the current session's conversation using the configured compactor, persists the result as a new `summary` event (so it survives reloads and composes with restore), emits `compaction` progress + completion events, then stops — it never produces a model answer. `foldEvents` now treats `summary` as a base reset, so loading a compacted session uses the compressed view with no kernel change.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/durable-compaction.md
git commit -m "chore: changeset for durable manual compaction"
```

---

## Self-Review

- **Spec coverage:** `summary` event + fold reset (T1), `compact()` action with progress/notify/persist/stop + event `kind` (T2), packaging (T3).
- **Action, not a turn:** `compact()` yields only `compaction` events and returns — no `run`/model answer. Matches "压缩只是动作，压缩结束后通知用户即可".
- **Durable + composable:** the summary persists; originals remain, so Plan 1 `restore(..., toSeq < summarySeq)` truncates past it and un-compacts. `foldEvents` reset means no kernel-load change.
- **Reuse:** uses the agent's configured `Compactor` (deterministic or LLM) and `estimateTokens` — no duplicated compaction logic.
- **Inert when unused:** the `events.ts` change is additive; sessions that never call `compact()` see no `summary` events and unchanged behavior.
- **Progress caveat:** the `Compactor` contract is a single `await` (no token streaming), so progress is coarse (`phase:"start"` → `phase:"done"`). Streaming the LLM summary would require extending the `Compactor` contract — deferred.
