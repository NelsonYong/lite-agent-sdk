# Part B-1 — Live Event Channel (real-time, completion-order, id-tagged) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make events emitted *during* tool execution stream to the consumer in real time (completion order), tagged by source id, so a UI can show concurrent tools — and especially subagents — live. Preserve the generator facade (`async function*` → `AgentEvent` / `RunResult`) and keep the **model-facing context deterministic** (tool_result blocks fed back to the model stay id-matched / input-order).

**Architecture:** The kernel's tool-execution phase is the only place that currently cannot stream: it `await`s the whole tool pool, buffering each call's emitted events in an isolated array and replaying them in input order afterward (`kernel.ts:139-178`). We replace that buffer-and-replay with a **push channel** the generator drains live: each tool's `emit` pushes straight into the channel; each call pushes its own `tool_result` on completion; the generator `for await`s the channel and `yield`s events as they arrive; when the pool settles the channel ends. The user message fed back to the model is assembled from a per-index `results[]` slot array in **input order** — independent of event timing. Subagent child events become live by changing `spawn` to forward the child's event stream through an `onEvent` callback; the `Agent` tool stamps each forwarded event with the child's `agentId`. Industry-aligned: this matches Claude Code (live partial-message stream + id-matched model context), pi (completion-order events tagged by tool-call id), and LangGraph (live event stream + order-independent state merge).

**Tech Stack:** TypeScript 6 (ESM, `moduleResolution: Bundler`), pnpm workspace, vitest, tsup. New runtime dep (core): `it-pushable` (ESM, ships its own types). See **Decision D1** for the hand-rolled fallback.

---

## Decisions (read before starting)

- **D1 — channel implementation.** Default: `it-pushable` (`pushable<AgentEvent>()`), aligned with the "prefer mature libraries" preference; it is the backbone of js-libp2p (battle-tested) though last published ~2023. **Fallback (if you'd rather not add a stale-ish dep for a tiny surface):** a ~25-line hand-rolled `AsyncQueue<AgentEvent>` in `packages/core/src/channel.ts` with the same three-method surface (`push`, `end`, async-iterate). Tasks below are written against a thin local interface so the two are interchangeable; Task 1 picks one.
- **D2 — attribution.** Add an optional `agentId?: string` to `AgentEvent` via a base intersection (`{ agentId?: string } & (…union…)`), so discriminated-union narrowing on `.type` still works. Main-agent events leave it `undefined`; forwarded subagent events carry the child session id. This is additive — no existing consumer breaks.
- **D3 — determinism split (the crux).** Only the **observational event stream** becomes completion-order. The **user message** pushed back to the model (`ctx.messages.push({ role: "user", content: resultBlocks })`) is built from `results[i]` in **input order** — so model-facing behavior and all checkpoint/message-order tests are unchanged. Only event-order assertions are rewritten.
- **D4 — scope.** This plan does NOT add steering (that is Part B-2) and does NOT change the `tool_use` up-front announce (still emitted in input order before execution). Out of scope: changing provider/codec, middleware, or the top-level lifecycle `drain()` checkpoints.

## File Structure

- `packages/core/package.json` — add `it-pushable` to `dependencies` (D1 lib path).
- `packages/core/src/channel.ts` — **(only if D1 = hand-rolled)** the `AsyncQueue` implementation + its unit test.
- `packages/core/src/events.ts` — add `agentId?: string` to `AgentEvent` (D2).
- `packages/core/src/kernel.ts` — replace the buffer-and-replay tool phase with the live channel (`~133-178`).
- `packages/core/test/kernel.test.ts` — rewrite two event-order tests for completion-order; keep their message-order assertions.
- `packages/sdk/src/tools/agent.ts` — `SpawnOptions` gains `onEvent?`; the `Agent` tool passes an `onEvent` that stamps `agentId`.
- `packages/sdk/src/createLiteAgent.ts` — `spawn` forwards child events via `child.run(...)` + `onEvent` instead of `child.send(...)`.
- `packages/sdk/test/agent-tool.test.ts` — add a test: a spawn that emits child events surfaces them live, tagged with `agentId`.
- `.changeset/partb1-live-event-channel.md` — minor changeset (new `agentId` field + live streaming are additive features).

> **Build choreography:** core's own tests run against `src`; sdk tests import `@lite-agent/core` from `dist`, so after the kernel/events changes run `pnpm --filter @lite-agent/core build` before the sdk tasks, and the final gate runs `pnpm -r build` first.

> **Branch:** create `feat/partb1-live-channel` off `main`; do not commit to `main` directly.

---

### Task 1: Add the channel dependency (or hand-rolled module)

**Files:** `packages/core/package.json` (+ `packages/core/src/channel.ts` if hand-rolled)

- [ ] **Step 1 (D1 = library):** `pnpm --filter @lite-agent/core add it-pushable`
  Then confirm the constructor surface against the installed version in a scratch check: the code uses `import { pushable } from "it-pushable"; const ch = pushable<AgentEvent>();` then `ch.push(ev)`, `ch.end()`, `for await (const ev of ch) …`. If the installed major requires `pushable<AgentEvent>({ objectMode: true })` for non-byte values, note that and use it consistently.

- [ ] **Step 1-alt (D1 = hand-rolled):** create `packages/core/src/channel.ts`:

```ts
/** Minimal push channel: push values, iterate them async, end to finish. */
export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(err?: Error): void;
}

export function channel<T>(): Channel<T> {
  const buf: T[] = [];
  let resolve: (() => void) | null = null;
  let done = false;
  let error: Error | undefined;
  const wake = () => { if (resolve) { const r = resolve; resolve = null; r(); } };
  return {
    push(value) { if (!done) { buf.push(value); wake(); } },
    end(err) { if (!done) { done = true; error = err; wake(); } },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (buf.length) yield buf.shift()!;
        if (done) { if (error) throw error; return; }
        await new Promise<void>((r) => { resolve = r; });
      }
    },
  };
}
```

  And its unit test `packages/core/test/channel.test.ts`:

```ts
import { expect, test } from "vitest";
import { channel } from "../src/channel";

test("channel yields pushed values in order then ends", async () => {
  const ch = channel<number>();
  ch.push(1); ch.push(2);
  queueMicrotask(() => { ch.push(3); ch.end(); });
  const got: number[] = [];
  for await (const v of ch) got.push(v);
  expect(got).toEqual([1, 2, 3]);
});

test("channel surfaces an end error to the consumer", async () => {
  const ch = channel<number>();
  ch.push(1);
  ch.end(new Error("boom"));
  const got: number[] = [];
  await expect((async () => { for await (const v of ch) got.push(v); })()).rejects.toThrow("boom");
  expect(got).toEqual([1]);
});
```

  Run: `pnpm --filter @lite-agent/core test -- channel` → PASS.

- [ ] **Step 2: Commit**

```bash
# library path:
git add packages/core/package.json pnpm-lock.yaml
# hand-rolled path:
# git add packages/core/src/channel.ts packages/core/test/channel.test.ts
git commit -m "feat(core): add push channel for live event streaming"
```

> For the rest of the plan, `mkChannel()` means either `pushable<AgentEvent>()` (lib) or `channel<AgentEvent>()` (hand-rolled). Use whichever Task 1 selected.

---

### Task 2: Add `agentId` to AgentEvent (D2)

**Files:** `packages/core/src/events.ts:38-51`, test `packages/core/test/events.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/events.test.ts`:

```ts
test("AgentEvent carries an optional agentId for source attribution", () => {
  const e: AgentEvent = { type: "text_delta", text: "hi", agentId: "agent-x" };
  expect(e.agentId).toBe("agent-x");
  const plain: AgentEvent = { type: "text_delta", text: "hi" };
  expect(plain.agentId).toBeUndefined();
});
```
(Add `import type { AgentEvent } from "../src/events";` if not already imported.)

- [ ] **Step 2: Run it — expect a TYPE failure** (`agentId` not assignable) at typecheck: `pnpm --filter @lite-agent/core typecheck` → FAIL.

- [ ] **Step 3: Implement** — in `packages/core/src/events.ts`, wrap the union with a base intersection. Change `export type AgentEvent =` to a private union plus an exported intersection:

```ts
type AgentEventBody =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "message"; message: AssistantMessage }
  | { type: "tool_use"; call: ToolCall }
  | { type: "approval_request"; call: ToolCall; reason?: string }
  | { type: "approval_resolved"; id: string; decision: "allow" | "deny"; by: string }
  | { type: "input_request"; call: ToolCall; question: UserQuestion }
  | { type: "input_resolved"; id: string; answer: UserAnswer }
  | { type: "tool_result"; result: ToolResult }
  | { type: "compaction"; kind: "micro" | "auto"; before: number; after: number }
  | { type: "turn_end"; turn: number; stopReason: StopReason }
  | { type: "error"; error: AgentError; fatal: boolean }
  | { type: "done"; reason: "stop" | "aborted" | "max_turns"; result: RunResult };

/** `agentId` is set on events forwarded from a subagent; undefined for the main agent. */
export type AgentEvent = { agentId?: string } & AgentEventBody;
```

- [ ] **Step 4: Verify** — `pnpm --filter @lite-agent/core typecheck` clean; `pnpm --filter @lite-agent/core test -- events` PASS. Then `pnpm --filter @lite-agent/core test` → all 109 still green (intersection preserves `.type` narrowing, so every existing `switch (e.type)` still compiles).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts packages/core/test/events.test.ts
git commit -m "feat(core): optional agentId on AgentEvent for source attribution"
```

---

### Task 3: Kernel — live channel in the tool phase (D3)

**Files:** `packages/core/src/kernel.ts` (the tool-execution block, currently `~133-178`)

- [ ] **Step 1: Add the import** at the top of `kernel.ts` (lib path): `import { pushable } from "it-pushable";` (or `import { channel } from "./channel";` for hand-rolled).

- [ ] **Step 2: Replace the tool-execution block.** The current block runs from the `for (const call of calls) yield { type: "tool_use", call };` line through `yield { type: "turn_end", turn, stopReason: "tool_use" };`. Replace everything from after the up-front `tool_use` announce down to (not including) the `turn_end` with:

```ts
    // All calls of this turn are in flight. Their emitted events stream LIVE into a
    // channel (completion order), so concurrent tools — and forwarded subagent events —
    // surface in real time. The model-facing user message is still assembled from
    // `results[i]` in INPUT order (D3): event timing never changes what the model sees.
    const ch = pushable<AgentEvent>();            // or channel<AgentEvent>() (D1)
    const results = new Array<ToolResult>(calls.length);

    const runCall = async (call: ToolCall, i: number): Promise<void> => {
      const callEmit = (ev: AgentEvent) => { ch.push(ev); };   // live, not buffered
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
      let result: ToolResult;
      try {
        result = await composeToolCall(cfg.middleware, tctx, baseExec)();
      } catch (e) {
        result = { id: call.id, name: call.name, content: `Error: ${(e as Error).message}`, isError: true };
      }
      await append({ type: "tool_result", result: toolResultBlock(result.id, result.content, result.isError), turn });
      results[i] = result;
      ch.push({ type: "tool_result", result });    // live tool_result (completion order)
    };

    const limit = pLimit(Math.max(1, cfg.maxParallelTools ?? 10));
    const pool = Promise.all(calls.map((call, i) => limit(() => runCall(call, i))));
    pool.then(() => ch.end(), (e) => ch.end(e as Error));
    for await (const ev of ch) yield ev;          // LIVE yield: tool emits + tool_results
    await pool;                                    // settle (results[] is now fully populated)

    const resultBlocks: ToolResultBlock[] = results.map((r) =>
      toolResultBlock(r.id, r.content, r.isError),
    );
    ctx.messages.push({ role: "user", content: resultBlocks });
```

  Then the existing `yield { type: "turn_end", turn, stopReason: "tool_use" };` line follows unchanged. The old isolated-buffer `runCall` (returning `{ events, result }`), the `runToolPool`/`Promise.all(...).map` outcome loop, and the `for (const { events, result } of outcomes)` replay are all removed by this replacement.

- [ ] **Step 3: Run kernel tests — expect TWO failures** (the event-order tests, fixed in Task 4): `pnpm --filter @lite-agent/core test -- kernel`. Expected to FAIL only on `"tool_result events ... stay in input order"` and `"each call's emitted events flush in input order, grouped with its result"`. All others (single-tool sequence, `maxInFlight`, abort-is-last, compaction-drains-before-message, checkpoint append order) must still PASS. If any OTHER test fails, stop and report — the refactor changed something it shouldn't.

- [ ] **Step 4: Typecheck** — `pnpm --filter @lite-agent/core typecheck` clean.

- [ ] **Step 5: Commit** (tests for the two rewrites land in Task 4; commit the kernel change now with the known-failing pair noted):

```bash
git add packages/core/src/kernel.ts
git commit -m "feat(core): stream tool-phase events live via a push channel (model context stays input-ordered)"
```

---

### Task 4: Rewrite the two event-order tests for completion-order

**Files:** `packages/core/test/kernel.test.ts` (the tests at `~254-279` and `~338-373`)

- [ ] **Step 1: Rewrite `"tool_result events and result blocks stay in input order regardless of completion order"`** (`~254-279`). Keep the same slow/fast setup. Change the **event** assertion to completion order, KEEP the **message-block** assertion in input order (D3):

```ts
test("tool_result EVENTS stream in completion order; the model message stays input-ordered", async () => {
  const fast = defineTool({ name: "fast", description: "f", schema: z.object({}), execute: async () => "FAST" });
  const slow = defineTool({
    name: "slow", description: "s", schema: z.object({}),
    execute: async () => { await new Promise((r) => setTimeout(r, 30)); return "SLOW"; },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "slow", input: {} }, // input order: slow first
      { type: "tool_call", id: "t2", name: "fast", input: {} }, // fast finishes first
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [slow, fast] }), "hi", new AbortController().signal, "s1"),
  );
  // EVENT stream: completion order — fast emits its tool_result before slow.
  const contents = events
    .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
    .map((e) => e.result.content);
  expect(contents).toEqual(["FAST", "SLOW"]);
  // MODEL message: still input order (t1=slow, t2=fast), independent of completion timing.
  const userMsg = result.messages.find(
    (m) => m.role === "user" && Array.isArray(m.content) && (m.content as ToolResultBlock[]).every((b) => b.type === "tool_result"),
  );
  expect((userMsg!.content as ToolResultBlock[]).map((b) => b.id)).toEqual(["t1", "t2"]);
  expect((userMsg!.content as ToolResultBlock[]).map((b) => b.content)).toEqual(["SLOW", "FAST"]);
});
```

- [ ] **Step 2: Rewrite `"each call's emitted events flush in input order, grouped with its result"`** (`~338-373`) → assert completion-order interleaving, robustly (rely on the 30 ms gap, not the micro-order of the two simultaneous `input_request`s):

```ts
test("a call's emitted events interleave live in completion order, each grouped with its own result", async () => {
  const slow = defineTool({
    name: "slow", description: "s", schema: z.object({}),
    execute: async (_i, ctx) => {
      ctx.emit({ type: "input_request", call: ctx.call!, question: { question: "slow?" } });
      await new Promise((r) => setTimeout(r, 30));
      return "SLOW";
    },
  });
  const fast = defineTool({
    name: "fast", description: "f", schema: z.object({}),
    execute: async (_i, ctx) => {
      ctx.emit({ type: "input_request", call: ctx.call!, question: { question: "fast?" } });
      return "FAST";
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "slow", input: {} },
      { type: "tool_call", id: "t2", name: "fast", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider, tools: [slow, fast] }), "hi", new AbortController().signal, "s1"),
  );
  const rel = events.filter((e) => e.type === "input_request" || e.type === "tool_result");
  // fast finishes first → its result precedes slow's result (completion order):
  const fastResultIdx = rel.findIndex((e) => e.type === "tool_result" && e.result.id === "t2");
  const slowResultIdx = rel.findIndex((e) => e.type === "tool_result" && e.result.id === "t1");
  expect(fastResultIdx).toBeLessThan(slowResultIdx);
  // each call's own input_request precedes its own tool_result:
  const idOf = (e: AgentEvent) => e.type === "tool_result" ? e.result.id : (e as Extract<AgentEvent, { type: "input_request" }>).call.id;
  const firstReq = (id: string) => rel.findIndex((e) => e.type === "input_request" && idOf(e) === id);
  const res = (id: string) => rel.findIndex((e) => e.type === "tool_result" && idOf(e) === id);
  expect(firstReq("t2")).toBeLessThan(res("t2"));
  expect(firstReq("t1")).toBeLessThan(res("t1"));
});
```

- [ ] **Step 3: Run** — `pnpm --filter @lite-agent/core test -- kernel` → ALL kernel tests pass. Then `pnpm --filter @lite-agent/core test` → full core suite green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/kernel.test.ts
git commit -m "test(core): event order is completion-order; model-message order stays input-ordered"
```

---

### Task 5: Forward subagent events live (spawn + Agent tool)

**Files:** `packages/sdk/src/tools/agent.ts` (`SpawnOptions`, `runOne`), `packages/sdk/src/createLiteAgent.ts:178-199`

> Rebuild core first so sdk sees the new types: `pnpm --filter @lite-agent/core build`.

- [ ] **Step 1: Extend the `Spawn` contract.** In `packages/sdk/src/tools/agent.ts`, add `AgentEvent` to the type imports (`import type { Tool, AgentEvent } from "@lite-agent/core";`) and add `onEvent` to `SpawnOptions`:

```ts
export interface SpawnOptions {
  signal: AbortSignal;
  sessionId: string;
  /** Live child event sink. The Agent tool stamps each event with the child agentId. */
  onEvent?: (e: AgentEvent) => void;
}
```

- [ ] **Step 2: Forward in the Agent tool.** In `runOne`, change the successful spawn call to pass an `onEvent` that stamps `agentId`:

```ts
          const out = await spawn(def, t.prompt, {
            signal: ctx.signal,
            sessionId,
            onEvent: (e) => ctx.emit({ ...e, agentId: sessionId }),
          });
```
(The surrounding `ctx.emit({ type: "tool_use", … })` before the call and `ctx.emit({ type: "tool_result", … })` after stay as-is: the subagent still brackets as a tool call, now with its live internals tagged in between.)

- [ ] **Step 3: Make `spawn` iterate the child stream.** In `packages/sdk/src/createLiteAgent.ts`, change the spawn body (currently `const r = await child.send(...); return r.text;`) to drive `child.run(...)` and forward each event:

```ts
      const spawn: Spawn = async (def, prompt, { signal, sessionId, onEvent }) => {
        const child = createLiteAgent({
          ...cfg,
          system:
            `You are the "${def.name}" subagent operating in ${cfg.workdir}. ` +
            `Return your final answer as your last message.\n\n${def.body}`,
          modelName: def.model ?? cfg.modelName,
          allowedTools: def.tools ?? cfg.allowedTools,
          agents: false,
          cleanup: false,
          permission: cfg.subagentPermission,
          onApproval: undefined,
          onAskUser: undefined,
          outputSchema: undefined,
          checkpointer: undefined,
        });
        const gen = child.run([{ role: "user", content: prompt }], { signal, sessionId });
        let r = await gen.next();
        while (!r.done) { onEvent?.(r.value); r = await gen.next(); }
        return r.value.text;
      };
```

- [ ] **Step 4: Write the test** in `packages/sdk/test/agent-tool.test.ts`:

```ts
test("subagent events are forwarded live, tagged with the child agentId", async () => {
  const events: AgentEvent[] = [];
  const ectx: ToolContext = { ...ctx, emit: (e) => events.push(e) };
  // spawn that emits a couple of child events through onEvent, then returns text.
  const spawn: Spawn = async (_def, _prompt, opts) => {
    opts.onEvent?.({ type: "text_delta", text: "thinking" });
    opts.onEvent?.({ type: "turn_end", turn: 1, stopReason: "stop" });
    return "child done";
  };
  const tool = agentTool({ loader: loaderWith("worker"), spawn });
  await tool.execute({ tasks: [{ subagent_type: "worker", prompt: "go" }] }, ectx);
  const fromChild = events.filter((e) => e.agentId);
  expect(fromChild.length).toBe(2);
  expect(fromChild.every((e) => e.agentId!.startsWith("agent-worker-"))).toBe(true);
  expect(fromChild.map((e) => e.type)).toEqual(["text_delta", "turn_end"]);
  // the Agent tool's own bracketing tool_use/tool_result are NOT tagged:
  const own = events.filter((e) => !e.agentId);
  expect(own.some((e) => e.type === "tool_use")).toBe(true);
  expect(own.some((e) => e.type === "tool_result")).toBe(true);
});
```

- [ ] **Step 5: Run** — `pnpm --filter @lite-agent/sdk test -- agent-tool` → all pass, including the existing subagent-as-tool-call tests (their fake spawns ignore `onEvent`, so no extra events). Then `pnpm --filter @lite-agent/sdk typecheck` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/tools/agent.ts packages/sdk/src/createLiteAgent.ts packages/sdk/test/agent-tool.test.ts
git commit -m "feat(sdk): forward subagent events live to the parent stream, tagged with agentId"
```

---

### Task 6: Full gate + changeset

**Files:** `.changeset/partb1-live-event-channel.md`

- [ ] **Step 1: Full gate** — `pnpm -r build && pnpm -r test && pnpm -r typecheck`. Expected: build OK; all packages green (core gains the `events`/`channel` tests, loses none; sdk gains the forwarding test); typecheck clean including `examples/cli`.

- [ ] **Step 2: Changeset** — create `.changeset/partb1-live-event-channel.md`:

```markdown
---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

Stream tool-phase events to consumers in real time (completion order) via a push channel, instead of buffering them until the tool pool drains. Subagent events are now forwarded live to the parent event stream, tagged with an optional `agentId` so UIs can route concurrent subagents to their own lanes. The model-facing context is unchanged: tool_result blocks are still assembled in input order and id-matched. Additive — existing consumers that ignore `agentId` and don't depend on concurrent-tool event ordering are unaffected.
```
(Minor, not patch: a new public field and a new streaming behavior — additive feature, not a fix.)

- [ ] **Step 3: Commit**

```bash
git add .changeset/partb1-live-event-channel.md
git commit -m "chore: changeset for live event channel"
```

> **Deferred (needs consent):** `pnpm version` / publish. Pin `checkpoint-sqlite` back if it cascade-bumps.

---

## Self-Review

- **Spec coverage:** live streaming (Task 3 channel), attribution (Task 2 `agentId`), subagent forwarding (Task 5), determinism split preserved (Task 3 `results[]` + Task 4 message-order assertion), tests updated (Task 4), packaging (Tasks 1, 6).
- **Determinism (D3) honored:** the only behavior that changed is observational event *order* for concurrent tools. `results[i]` keeps the model message input-ordered; checkpoint append order is per-completion as today; single-tool and lifecycle/compaction tests are untouched.
- **Facade preserved:** `runKernel` is still `async function*` → `AgentEvent` / `RunResult`; `done` still last; `run()`/`query()` still pass the generator through. forge/CLI unaffected at the contract level (they gain extra `agentId`-tagged events they can ignore).
- **Type consistency:** `mkChannel()` surface (`push`/`end`/async-iterate) is identical for lib and hand-rolled. `agentId` added via intersection so every `switch (e.type)` still narrows. `SpawnOptions.onEvent` matches the `ctx.emit` stamping closure.
- **No silent caps / no scope creep:** steering is explicitly out (B-2); the up-front `tool_use` announce and lifecycle `drain()` are unchanged.
- **Risk watch:** Task 3 Step 3 explicitly lists which tests may fail (the two order tests) vs which must NOT — a guard against the refactor changing more than intended.
