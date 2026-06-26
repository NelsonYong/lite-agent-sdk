# Concurrent In-Turn Tool Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the kernel run all of an assistant turn's tool calls concurrently (default-on, bounded, deterministic ordering), so multiple `Agent`/tool calls fan out in parallel instead of serializing.

**Architecture:** The kernel's per-turn tool loop changes from a sequential `for` loop to a bounded concurrent pool. Each call runs with an isolated event buffer; `tool_use` events lead, then each call's buffered events + `tool_result` flush in **input order** (deterministic). The permission gate serializes concurrent approval prompts via a closure mutex. A new optional `maxParallelTools` (default 10; `1` = sequential) threads from `query`/`createLiteAgent`/`createAgent` into `KernelConfig`.

**Tech Stack:** TypeScript (ESM, strict), vitest, zod. Monorepo packages `@lite-agent/core` and `@lite-agent/sdk`. Tests run against source for core; the sdk test imports core via its **built `dist/`**, so core must be rebuilt before running sdk tests.

---

## Background the implementer needs

**The spec:** `docs/superpowers/specs/2026-06-26-concurrent-tool-execution-design.md`. Read it for rationale; this plan is self-contained for implementation.

**Key existing types** (`packages/core/src/types.ts`):
```ts
export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; name: string; content: string; isError?: boolean };
export type ToolResultBlock = { type: "tool_result"; id: string; content: string; isError?: boolean };
export const toolResultBlock = (id: string, content: string, isError = false): ToolResultBlock => /* ... */;
```

**Test helpers** (`packages/core/src/testing/fakeProvider.ts`, used in `packages/core/test/kernel.test.ts`):
- `fakeProvider(steps)` — each step is `{ text?, message }`; the kernel decodes `tool_call` content blocks into tool calls. Multiple `tool_call` blocks in one `message` → multiple calls in one turn.
- The existing `baseCfg(over)` and `drain(gen)` helpers in `kernel.test.ts` are reused (do not redefine them).

**Build-before-test choreography:** core tests import `../src/...` directly (no build needed). The sdk test in Task 3 imports `@lite-agent/core` from its built `dist/`, so Task 3 **rebuilds core first**.

**Git identity:** commits in this repo are authored as `NelsonYong <1013588891@qq.com>` (already set as repo-local git config — verify with `git config user.name` before the first commit; it should print `NelsonYong`).

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/core/src/kernel.ts` | per-turn loop | Add `maxParallelTools?` to `KernelConfig`; replace sequential tool loop with a bounded concurrent pool + per-call event buffers + input-ordered flush; add module-local `runToolPool`. |
| `packages/core/src/permission.ts` | permission gate middleware | Serialize concurrent `approval.request` calls via a closure promise-chain mutex. |
| `packages/core/src/createAgent.ts` | core agent factory | Add `maxParallelTools?` to `CreateAgentConfig`; pass into `KernelConfig`. |
| `packages/sdk/src/createLiteAgent.ts` | sdk agent factory | Add `maxParallelTools?` to `CreateLiteAgentConfig`; forward to `createAgent`. (Subagent children inherit it via the existing `...cfg` spread.) |
| `packages/sdk/src/query.ts` | sdk facade | Add `maxParallelTools?` to `QueryOptions`; forward to `createLiteAgent`. |
| `packages/core/test/kernel.test.ts` | kernel tests | Add concurrency / determinism / cap tests. |
| `packages/core/test/permission.test.ts` | permission tests | Add approval-serialization test. |
| `packages/sdk/test/query.test.ts` | sdk tests | Add `maxParallelTools` forwarding tests. |
| `.changeset/concurrent-tool-execution.md` | release notes | Minor bump for the fixed group. |

---

### Task 1: Kernel — concurrent tool execution

**Files:**
- Modify: `packages/core/src/kernel.ts`
- Test: `packages/core/test/kernel.test.ts`

- [ ] **Step 1: Write the failing concurrency test + two guard tests**

Append these three tests to `packages/core/test/kernel.test.ts`. They reuse the file's existing `baseCfg`, `drain`, `fakeProvider`, `defineTool`, `textBlock`, `z` imports. Add `ToolResultBlock` to the existing `import type { Message } from "../src/types";` line so it reads:
`import type { Message, ToolResultBlock } from "../src/types";`

```ts
test("multiple tool calls in one turn run concurrently", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (name: string) =>
    defineTool({
      name, description: name, schema: z.object({}),
      execute: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return name;
      },
    });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "a", input: {} },
      { type: "tool_call", id: "t2", name: "b", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  await drain(
    runKernel(baseCfg({ provider, tools: [slow("a"), slow("b")] }), "hi", new AbortController().signal, "s1"),
  );
  expect(maxInFlight).toBe(2);
});

test("tool_result events and result blocks stay in input order regardless of completion order", async () => {
  const fast = defineTool({ name: "fast", description: "f", schema: z.object({}), execute: async () => "FAST" });
  const slow = defineTool({
    name: "slow", description: "s", schema: z.object({}),
    execute: async () => { await new Promise((r) => setTimeout(r, 30)); return "SLOW"; },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "slow", input: {} }, // input order: slow first
      { type: "tool_call", id: "t2", name: "fast", input: {} }, // but fast finishes first
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [slow, fast] }), "hi", new AbortController().signal, "s1"),
  );
  const contents = events
    .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
    .map((e) => e.result.content);
  expect(contents).toEqual(["SLOW", "FAST"]);
  const userMsg = result.messages.find(
    (m) => m.role === "user" && Array.isArray(m.content) && (m.content as ToolResultBlock[]).every((b) => b.type === "tool_result"),
  );
  expect((userMsg!.content as ToolResultBlock[]).map((b) => b.id)).toEqual(["t1", "t2"]);
  expect((userMsg!.content as ToolResultBlock[]).map((b) => b.content)).toEqual(["SLOW", "FAST"]);
});

test("maxParallelTools: 1 forces sequential execution", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (name: string) =>
    defineTool({
      name, description: name, schema: z.object({}),
      execute: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return name;
      },
    });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "a", input: {} },
      { type: "tool_call", id: "t2", name: "b", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  await drain(
    runKernel(baseCfg({ provider, tools: [slow("a"), slow("b")], maxParallelTools: 1 }), "hi", new AbortController().signal, "s1"),
  );
  expect(maxInFlight).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify the concurrency test fails**

Run: `pnpm --filter @lite-agent/core test -- kernel`
Expected: the **"multiple tool calls in one turn run concurrently"** test FAILS with `expected 1 to be 2` (today's sequential loop never overlaps). The two guard tests ("input order" and "maxParallelTools: 1") PASS, because sequential execution trivially preserves order and never overlaps — they lock the invariant once concurrency lands.

- [ ] **Step 3: Add `maxParallelTools` to `KernelConfig`**

In `packages/core/src/kernel.ts`, add the field to the `KernelConfig` interface (after `store?: Store;`):

```ts
  store?: Store;
  /** Max tool calls run concurrently within one assistant turn. Default 10; 1 = sequential. */
  maxParallelTools?: number;
```

- [ ] **Step 4: Extend the kernel's type imports**

In `packages/core/src/kernel.ts`, change the `./types` import (currently line 2) to add `ToolCall` and `ToolResult`:

```ts
import type { AssistantMessage, Message, ToolCall, ToolResult, ToolResultBlock, Usage } from "./types";
```

- [ ] **Step 5: Replace the sequential tool loop with the concurrent pool**

In `packages/core/src/kernel.ts`, replace the entire block from `const resultBlocks: ToolResultBlock[] = [];` through the end of the `for (const call of calls) { ... }` loop and the two lines after it (`ctx.messages.push(...)` and `await persist();`) — i.e. the current lines 101–122 — with:

```ts
    // All calls of this turn are now in flight: announce them up front, in input order.
    for (const call of calls) yield { type: "tool_use", call };

    // Each call runs with an ISOLATED emit buffer so a sibling's events (approval_*,
    // tool emits) don't interleave non-deterministically. Buffers flush in input order
    // after the pool drains, so the event stream stays deterministic.
    const runCall = async (
      call: ToolCall,
    ): Promise<{ events: AgentEvent[]; result: ToolResult }> => {
      const events: AgentEvent[] = [];
      const callEmit = (ev: AgentEvent) => { events.push(ev); };
      const tctx: ToolCallContext = { ...ctx, call, emit: callEmit };
      const tool = toolMap.get(call.name);
      const baseExec = async (): Promise<ToolResult> => {
        if (!tool) return { id: call.id, name: call.name, content: `Error: unknown tool '${call.name}'`, isError: true };
        try {
          const parsed = tool.schema.parse(call.input);
          const out = await tool.execute(parsed, { sessionId, signal, emit: callEmit, sandbox: cfg.sandbox, input: cfg.input, call });
          return { id: call.id, name: call.name, content: String(out) };
        } catch (e) {
          return { id: call.id, name: call.name, content: `Error: ${(e as Error).message}`, isError: true };
        }
      };
      const result = await composeToolCall(cfg.middleware, tctx, baseExec)();
      return { events, result };
    };

    const outcomes = await runToolPool(calls, cfg.maxParallelTools ?? 10, runCall);

    const resultBlocks: ToolResultBlock[] = [];
    for (const { events, result } of outcomes) {
      for (const ev of events) yield ev;
      resultBlocks.push(toolResultBlock(result.id, result.content, result.isError));
      yield { type: "tool_result", result };
    }
    ctx.messages.push({ role: "user", content: resultBlocks });
    await persist();
```

(The `yield { type: "turn_end", turn, stopReason: "tool_use" };` line immediately below stays unchanged.)

- [ ] **Step 6: Add the `runToolPool` helper**

In `packages/core/src/kernel.ts`, add this function at module scope (next to `lastAssistantText` at the bottom of the file):

```ts
/** Run `fn` over `calls` with at most `limit` in flight; results stay input-ordered. */
async function runToolPool<R>(
  calls: ToolCall[],
  limit: number,
  fn: (call: ToolCall) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(calls.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < calls.length) {
      const i = next++;
      results[i] = await fn(calls[i]!);
    }
  };
  const workers = Math.max(1, Math.min(limit, calls.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
```

(`i = next++` runs synchronously before the `await`, so no two workers claim the same index. `Math.max(1, …)` ensures `limit: 1` runs a single worker → strictly sequential.)

- [ ] **Step 7: Run the kernel tests to verify they pass**

Run: `pnpm --filter @lite-agent/core test -- kernel`
Expected: PASS — all kernel tests green, including the three new ones (concurrency now observes `maxInFlight === 2`).

- [ ] **Step 8: Run the full core suite to verify no regression**

Run: `pnpm --filter @lite-agent/core test`
Expected: PASS — every core test green (single-tool turns are byte-for-byte unchanged; no existing test asserts multi-tool event ordering).

- [ ] **Step 9: Typecheck core**

Run: `pnpm --filter @lite-agent/core typecheck`
Expected: PASS — no type errors (the new `ToolCall`/`ToolResult` imports and `maxParallelTools` field resolve cleanly).

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/kernel.ts packages/core/test/kernel.test.ts
git commit -m "feat(core): run a turn's tool calls concurrently (bounded, input-ordered)"
```

---

### Task 2: Permission — serialize concurrent approval prompts

**Files:**
- Modify: `packages/core/src/permission.ts`
- Test: `packages/core/test/permission.test.ts`

- [ ] **Step 1: Write the failing serialization test**

Append to `packages/core/test/permission.test.ts` (it already imports `policy`, `permission`, `composeToolCall`, `vi`, `okExec`, `ctxFor`, and `ApprovalHandler`):

```ts
test("permission serializes concurrent approval prompts (no overlap)", async () => {
  let active = 0;
  let maxActive = 0;
  const approval: ApprovalHandler = {
    request: async (): Promise<"allow" | "deny"> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return "allow";
    },
  };
  // One shared permission middleware instance gates both concurrent calls.
  const mw = permission(policy({ ask: ["bash"] }), approval);
  const results = await Promise.all([
    composeToolCall([mw], ctxFor("bash", () => {}), okExec)(),
    composeToolCall([mw], ctxFor("bash", () => {}), okExec)(),
  ]);
  expect(maxActive).toBe(1); // prompts never overlapped
  expect(results.every((r) => r.content === "ran")).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: the new test FAILS with `expected 2 to be 1` (today both `approval.request` calls run at once → `maxActive === 2`).

- [ ] **Step 3: Add the closure mutex to `permission()`**

In `packages/core/src/permission.ts`, add `ToolCall` to the `./types` import (currently `import type { ToolResult } from "./types";`):

```ts
import type { ToolCall, ToolResult } from "./types";
```

Then replace the `permission` function body (currently lines 41–54) with:

```ts
// Gate middleware (spec §6): allow → run; deny → blocked; ask → emit request, await approver, emit resolved.
export function permission(pol: PermissionPolicy, approval?: ApprovalHandler): Middleware {
  // Serialize interactive approval prompts: with concurrent in-turn tool execution,
  // multiple ask-gated calls would otherwise prompt at the same time and overlap.
  let lock: Promise<unknown> = Promise.resolve();
  const requestSerial = (call: ToolCall): Promise<Decision> => {
    const run = lock.then(() => approval!.request(call));
    lock = run.then(() => undefined, () => undefined); // advance the chain regardless of outcome
    return run;
  };
  return {
    name: "permission",
    async wrapToolCall(ctx, next) {
      const decision = await pol.check(ctx.call, { sessionId: ctx.sessionId });
      if (decision === "allow") return next();
      if (decision === "deny") return denied(ctx, "blocked by policy");
      ctx.emit({ type: "approval_request", call: ctx.call });
      const resolved = approval ? await requestSerial(ctx.call) : "deny";
      ctx.emit({ type: "approval_resolved", id: ctx.call.id, decision: resolved, by: approval ? "user" : "auto" });
      return resolved === "allow" ? next() : denied(ctx, "denied by user");
    },
  };
}
```

(`Decision` is already imported at the top of `permission.ts`. The non-null `approval!` inside `requestSerial` is safe: it is only called from the `approval ? … : "deny"` branch.)

- [ ] **Step 4: Run the permission tests to verify they pass**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: PASS — the new serialization test (`maxActive === 1`) and all existing permission tests green (single-call behavior, events, deny/allow paths unchanged).

- [ ] **Step 5: Typecheck core**

Run: `pnpm --filter @lite-agent/core typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/permission.ts packages/core/test/permission.test.ts
git commit -m "feat(core): serialize concurrent approval prompts in the permission gate"
```

---

### Task 3: Thread `maxParallelTools` through createAgent / createLiteAgent / query

**Files:**
- Modify: `packages/core/src/createAgent.ts`
- Modify: `packages/sdk/src/createLiteAgent.ts`
- Modify: `packages/sdk/src/query.ts`
- Test: `packages/sdk/test/query.test.ts`

- [ ] **Step 1: Add the option to `CreateAgentConfig` and pass it into the kernel**

In `packages/core/src/createAgent.ts`, add the field to `CreateAgentConfig` (after `store?: Store;`):

```ts
  store?: Store;
  /** Max tool calls run concurrently per turn (default 10; 1 = sequential). */
  maxParallelTools?: number;
```

And in the `kernelCfg` object literal (after `store: cfg.store,`):

```ts
    store: cfg.store,
    maxParallelTools: cfg.maxParallelTools,
```

- [ ] **Step 2: Add the option to `CreateLiteAgentConfig` and forward to `createAgent`**

In `packages/sdk/src/createLiteAgent.ts`, add the field to `CreateLiteAgentConfig` (after `maxTokens?: number;`):

```ts
  maxTokens?: number;
  /** Max tool calls run concurrently per turn (default 10; 1 = sequential). Inherited by subagents. */
  maxParallelTools?: number;
```

And in the `createAgent({ ... })` call (after `maxTokens: cfg.maxTokens,`):

```ts
    maxTokens: cfg.maxTokens,
    maxParallelTools: cfg.maxParallelTools,
```

(No change is needed in the subagent `spawn` closure: it builds the child via `createLiteAgent({ ...cfg, ... })`, so the child inherits `maxParallelTools` automatically.)

- [ ] **Step 3: Add the option to `QueryOptions` and forward to `createLiteAgent`**

In `packages/sdk/src/query.ts`, add the field to `QueryOptions` (after `maxTokens?: number;`):

```ts
  maxTokens?: number;
  maxParallelTools?: number;
```

And in the `createLiteAgent({ ... })` call (after `maxTokens: opts.maxTokens,`):

```ts
    maxTokens: opts.maxTokens,
    maxParallelTools: opts.maxParallelTools,
```

- [ ] **Step 4: Write the forwarding tests**

Append to `packages/sdk/test/query.test.ts` (it already imports `query`, `tool`, `z`, `fakeProvider`, `textBlock`, `mkdtempSync`, `tmpdir`, `join`):

```ts
test("query forwards maxParallelTools — tool calls run concurrently by default", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (name: string) =>
    tool(name, name, z.object({}), async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return name;
    });
  const fp = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "ta", input: {} },
      { type: "tool_call", id: "t2", name: "tb", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const gen = query({ prompt: "go", model: fp, cwd: mkdtempSync(join(tmpdir(), "mpt-")), tools: [slow("ta"), slow("tb")] });
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  expect(maxInFlight).toBe(2);
});

test("query forwards maxParallelTools: 1 — tool calls run sequentially", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (name: string) =>
    tool(name, name, z.object({}), async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return name;
    });
  const fp = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "ta", input: {} },
      { type: "tool_call", id: "t2", name: "tb", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const gen = query({ prompt: "go", model: fp, cwd: mkdtempSync(join(tmpdir(), "mpt-")), tools: [slow("ta"), slow("tb")], maxParallelTools: 1 });
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  expect(maxInFlight).toBe(1);
});
```

- [ ] **Step 5: Rebuild core (the sdk test imports core from `dist/`)**

Run: `pnpm --filter @lite-agent/core build`
Expected: PASS — `dist/` regenerated with Tasks 1–2 changes (so the sdk test exercises the concurrent kernel, not stale dist).

- [ ] **Step 6: Run the sdk forwarding tests to verify they pass**

Run: `pnpm --filter @lite-agent/sdk test -- query`
Expected: PASS — the default test observes `maxInFlight === 2`; the `maxParallelTools: 1` test observes `maxInFlight === 1`. This proves the option threads `query → createLiteAgent → createAgent → KernelConfig`.

- [ ] **Step 7: Typecheck core and sdk**

Run: `pnpm --filter @lite-agent/core typecheck && pnpm --filter @lite-agent/sdk typecheck`
Expected: PASS — both packages typecheck (the new option is consistently typed across all four interfaces).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/createAgent.ts packages/sdk/src/createLiteAgent.ts packages/sdk/src/query.ts packages/sdk/test/query.test.ts
git commit -m "feat(sdk): expose maxParallelTools through createAgent/createLiteAgent/query"
```

---

### Task 4: Changeset

**Files:**
- Create: `.changeset/concurrent-tool-execution.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/concurrent-tool-execution.md` with exactly:

```markdown
---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

feat: run a turn's tool calls concurrently (default-on; cap `maxParallelTools`, default 10)

The kernel now executes all tool calls of a single assistant turn in parallel,
bounded by `maxParallelTools` (default 10; set to 1 for the old sequential
behavior). Output stays deterministic — `tool_result` blocks and events flush in
input order regardless of completion timing — and the permission gate serializes
concurrent approval prompts. Multiple `Agent` (subagent) calls in one turn now fan
out simultaneously instead of running one after another.
```

(The four packages are a `fixed` changeset group, so listing core + sdk bumps all four to the same minor.)

- [ ] **Step 2: Verify the changeset is recognized**

Run: `pnpm exec changeset status`
Expected: lists the four fixed packages (`@lite-agent/core`, `@lite-agent/sdk`, `@lite-agent/provider`, `@lite-agent/sandbox-anthropic`) bumping **minor**. (If `changeset status` errors comparing to `main`, this is non-fatal — confirm instead that the file exists and is well-formed.)

- [ ] **Step 3: Commit**

```bash
git add .changeset/concurrent-tool-execution.md
git commit -m "chore: changeset for concurrent in-turn tool execution"
```

---

## Final verification (after all tasks)

- [ ] **Full build + test + typecheck across the monorepo**

Run: `pnpm -r build && pnpm -r test && pnpm -r typecheck`
Expected: PASS — all packages build (topological order), all tests green, no type errors. This is the authoritative cross-package check (it rebuilds core so the sdk/example see the concurrent kernel).

## Notes / out of scope (do not implement)

- **`ask_user` / `InputHandler` is NOT serialized** — only the approval gate is. Subagents run with `onAskUser: undefined` and the main agent rarely batches `ask_user`, so overlapping input prompts are an accepted edge case (per spec "Known limitations").
- **No change to the `Agent` tool** — its internal `runPool` cap stays 5; do not touch `packages/sdk/src/tools/agent.ts`.
- **No live streaming of subagent events** — spawning still swallows child events and returns final text only.
- **Versioning/publish is a separate, user-initiated step** — this plan adds the changeset but does NOT run `changeset version` or publish.
