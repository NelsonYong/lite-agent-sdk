# Concurrent in-turn tool execution (Path B) — Design

**Date:** 2026-06-26
**Status:** Approved (brainstorming)
**Packages touched:** `@lite-agent/core` (kernel + permission), `lite-agent` (sdk — option pass-through)

## Problem

When the model emits multiple tool calls in a single assistant turn, the kernel runs
them **strictly sequentially** (`packages/core/src/kernel.ts:102` — `for (const call of calls)`
with `await composeToolCall(...)` inside). Each call blocks the next.

The motivating case is the `Agent` dispatch tool: the user wants to fan out **multiple
subagents that run in parallel**, and have the main agent summarize once all finish. Today,
even if the model emits several `Agent` calls (or several independent calls of any tool) in
one turn, they execute one after another — the second subagent only starts after the first
returns. (The `Agent` tool's *own* internal `runPool` parallelizes the `tasks` array within a
single call, but separate tool calls in the same turn still serialize at the kernel.)

Claude Code's model is the opposite: the harness runs the tool calls of one assistant message
concurrently, waits for all, then feeds the combined results back. We want the kernel to do the
same. The user explicitly does **not** want live streaming of each subagent's internal events —
only parallel fan-out, join, then a single summary turn.

## Goals

- The kernel runs all tool calls of one assistant turn **concurrently**, bounded by a cap.
- **Default-on**: no opt-in flag. Concurrency is the new default behavior.
- **Deterministic output**: the message history (the `tool_result` blocks pushed back to the
  model) and the event stream are ordered by **input order**, independent of completion timing.
  So runs stay reproducible and existing golden tests hold.
- **Approval prompts stay serialized**: concurrent ask-gated tools must not overlap their
  interactive prompts.
- **Configurable cap** `maxParallelTools`, default **10**; `maxParallelTools: 1` reproduces the
  old strictly-sequential behavior (the opt-out, no separate boolean).
- The `Agent` tool's internal `runPool` cap stays **5** (a separate nesting layer).

## Non-goals

- No live/streamed view of a subagent's internal events into the parent stream (explicitly
  rejected). Subagent spawning still swallows child events and returns only final text.
- No automatic detection of inter-tool dependencies. The model is responsible for only batching
  calls that are safe to run together (same contract as Claude Code).
- No change to the `Agent` tool, its `tasks` fan-out, or subagent isolation/persistence.
- No serialization of `ask_user` / `InputHandler` prompts (see "Known limitations").

## Design

### 1. Kernel: concurrent tool loop with per-call event isolation

`packages/core/src/kernel.ts` — replace the sequential `for (const call of calls)` block
(lines 101–120) with: emit all `tool_use` events up front, run all calls through a bounded
pool, then flush each call's buffered events + its `tool_result` **in input order**.

```ts
// All calls of this turn are now in flight: announce them up front, in input order.
for (const call of calls) yield { type: "tool_use", call };

// Each call runs with an ISOLATED emit buffer so its events (approval_*, tool emits)
// don't interleave non-deterministically with sibling calls. Buffers are flushed in
// input order after the pool drains, so the event stream is deterministic.
const runCall = async (call: ToolCall): Promise<{ events: AgentEvent[]; result: ToolResult }> => {
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

const limit = cfg.maxParallelTools ?? 10;
const outcomes = await runToolPool(calls, limit, runCall);

const resultBlocks: ToolResultBlock[] = [];
for (const { events, result } of outcomes) {     // input order
  for (const ev of events) yield ev;             // this call's buffered events, in input order
  resultBlocks.push(toolResultBlock(result.id, result.content, result.isError));
  yield { type: "tool_result", result };
}
ctx.messages.push({ role: "user", content: resultBlocks });
```

The bounded, input-ordered pool (module-local in `kernel.ts`; core cannot import the sdk's
`runPool`):

```ts
async function runToolPool<R>(
  items: ToolCall[],
  limit: number,
  fn: (item: ToolCall) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
```

`i = next++` is synchronous before the `await`, so workers never claim the same index — no race
(same pattern as the sdk `Agent` tool's existing `runPool`). `Math.max(1, …)` means
`maxParallelTools: 1` runs a single worker → strictly sequential, reproducing today's behavior.

The per-turn `emit`/`queue` from `mkCtx` is unchanged for the lifecycle/model phases; only the
tool phase swaps in a per-call `callEmit`. The `yield* drain()` that previously sat **inside**
the tool loop (line 117) is removed (the shared queue receives nothing during tool execution
now). All other `drain()` calls are untouched.

### 2. Permission: serialize interactive approval prompts

`packages/core/src/permission.ts` — concurrent ask-gated tools would call `approval.request()`
simultaneously and overlap their prompts. Add a closure-level promise-chain mutex inside the
`permission()` middleware so the interactive requests resolve one at a time. One `permission()`
instance gates every tool call (it lives once in the middleware array), so a closure lock
serializes across the whole turn.

```ts
export function permission(pol: PermissionPolicy, approval?: ApprovalHandler): Middleware {
  // Serialize interactive approval prompts: with concurrent in-turn tool execution,
  // multiple ask-gated calls would otherwise prompt at the same time and overlap.
  let lock: Promise<unknown> = Promise.resolve();
  const requestSerial = (call: ToolCall): Promise<Decision> => {
    const run = lock.then(() => approval!.request(call));
    lock = run.then(() => undefined, () => undefined); // chain regardless of outcome
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

The `approval_request` event is still emitted before acquiring the lock; because events are
buffered per call and flushed in input order, this does not affect the (now serialized) live I/O.
This matches the documented "events are observational" model — the live prompt is driven by the
handler's I/O, not by the event.

### 3. Config: thread `maxParallelTools` (default 10)

- `KernelConfig` (`kernel.ts`): add `maxParallelTools?: number` (optional; the kernel defaults
  to `10` at the use site via `cfg.maxParallelTools ?? 10`). Optional keeps existing
  `KernelConfig` literals in tests valid without edits.
- `CreateAgentConfig` (`createAgent.ts`): add `maxParallelTools?: number`; pass through to the
  kernel config as `maxParallelTools: cfg.maxParallelTools` (undefined → kernel default).
- `CreateLiteAgentConfig` (`createLiteAgent.ts`): add `maxParallelTools?: number`; forward to
  `createAgent({ …, maxParallelTools: cfg.maxParallelTools })`. The subagent spawn closure
  inherits it via the existing `...cfg` spread (children keep the same cap; combined with the
  `Agent` `runPool` of 5, worst-case nesting is bounded — noted below).
- `QueryOptions` (`query.ts`): add `maxParallelTools?: number`; forward to `createLiteAgent`.

## Data flow / determinism

For a turn with calls `[A, B, C]`:

1. `tool_use` events emitted in order: A, B, C (all in flight).
2. All three run concurrently (≤ `maxParallelTools` at once); each writes its own event buffer.
3. After all finish, flush in input order: A's buffered events then A's `tool_result`, then B's,
   then C's. `resultBlocks` pushed `[A, B, C]` regardless of who finished first.

**Single-tool turns are byte-for-byte unchanged**: one `tool_use`, the call's buffered events,
one `tool_result` — identical order and content to today.

**Event-order change for multi-tool turns only**: today the stream interleaves per call
(`tool_use[A], …A events…, tool_result[A], tool_use[B], …`); now all `tool_use` lead
(`tool_use[A], tool_use[B], tool_use[C], …A events…, tool_result[A], …B…, …C…`). No existing
test asserts multi-tool ordering, so this is a safe, intentional change.

## Concurrency safety

- **Tools** receive a `ToolContext` without `messages`, so a tool cannot mutate shared history;
  `tool_result` blocks are collected by the kernel and pushed once, after the pool drains.
- **`ctx.messages`**: not mutated during the tool phase (the assistant message was pushed before
  the loop; the user/result message is pushed after). Concurrent tools never race on it.
- **`ctx.state`** (the shared `Map`): a `wrapToolCall` middleware that writes shared `state`
  keys concurrently could race. No shipped middleware does this in `wrapToolCall` (compaction
  uses `state` only in `beforeModel`; permission now uses a closure lock, not `state`). Documented
  constraint: `wrapToolCall` middleware must treat `ctx.state`/`ctx.messages` as read-mostly
  under concurrency.
- **Abort**: every call observes the same `signal`; a tool that throws or bails is caught by its
  own `baseExec` try/catch and becomes an error `ToolResult` — the batch is never rejected, same
  as the sequential version. Turn-boundary abort handling is unchanged.

## Known limitations

- **`ask_user` / `InputHandler` is not serialized.** Subagents run with `onAskUser: undefined`,
  and the main agent rarely batches `ask_user` calls in one turn, so overlapping interactive
  input prompts are an accepted edge case for this iteration. The same closure-lock pattern can
  be applied later if needed.
- **Nesting depth.** A parent turn runs ≤ `maxParallelTools` (10) calls; if several are `Agent`
  calls, each fans out ≤ 5 child tasks via `runPool`, and each child kernel again allows ≤ 10
  concurrent tool calls. Worst-case in-flight work multiplies across layers. This is inherent to
  recursive delegation and bounded at each layer; we keep the `Agent` `runPool` at 5 to damp it.

## Testing

core (`packages/core/test/kernel.test.ts`):

- **Concurrency**: a turn with two tool calls whose tools increment a shared in-flight counter
  and sleep briefly observes `maxInFlight === 2` (they overlap).
- **Deterministic order**: a slow first call + a fast second call still yields `tool_result`
  events and result blocks in input order `[first, second]`.
- **Cap = sequential**: with `maxParallelTools: 1`, the same two-call turn observes
  `maxInFlight === 1`.
- **Regression**: the existing single-tool and unknown-tool sequences are unchanged.

core (`packages/core/test/permission.test.ts`):

- **Approval serialization**: two ask-gated calls composed through **one** shared `permission`
  middleware instance, run via `Promise.all`, with an approval handler that tracks concurrent
  entries → `maxActive === 1` (serialized), both ultimately allowed.

sdk (`packages/sdk/test/`):

- `query`/`createLiteAgent` forward `maxParallelTools` to the kernel (a smoke assertion that the
  option threads through, e.g. via a custom provider/tool observing concurrency, or by asserting
  the value reaches `createAgent`). Minimal — the behavior is covered in core.

## Compatibility

- Adding an optional `maxParallelTools` to four config interfaces is additive/source-compatible.
- Default behavior changes from sequential to concurrent **for multi-tool turns only**; single
  tool turns are identical. Output ordering stays deterministic.
- Changeset: **minor** bump across the four fixed packages (new public option + new default
  execution behavior).
