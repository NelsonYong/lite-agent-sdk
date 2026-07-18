# The kernel

The kernel is the turn loop at the heart of `@lite-agent/core`: encode → call → decode → execute → feed back, repeated until the model stops. Understanding it pays off everywhere — it tells you exactly where a strategy plugs in, where a middleware wraps, and when an event fires. The kernel itself knows nothing about permissions or compaction — those are middleware. The loop body is just "encode → call → decode → execute → feed back".

## Usage

`createAgent(config)` assembles a `KernelConfig` and returns an `Agent` with two entry points:

- `run(input, opts?)` — an async generator that yields every `AgentEvent` and returns the `RunResult`.
- `send(input, opts?)` — drains the same generator and resolves with just the `RunResult`.

Both accept `{ signal, sessionId, steer }` via `RunOptions`.

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

for await (const ev of agent.run("hello", { signal: AbortSignal.timeout(30_000) })) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

## One run, step by step

1. **Load the session.** If a `checkpointer` is configured, the event log is replayed and `foldEvents` rebuilds the message list; with `crashRecovery: "safe"`, tools that started but never finished get a synthetic error `tool_result`.
2. **Run `beforeAgent` hooks** (once per run), then drain the event queue.
3. **Start a turn** — yield `turn_start`, apply pending steers and background-task completions, then run `beforeModel` hooks (this is where compaction middleware lives).
4. **Call the model.** The request is encoded by the `ToolCallCodec`, streamed through the `wrapModelCall` middleware chain, and surfaced as `text_delta` events. A context-overflow error before any chunk streamed triggers one emergency compaction + retry when the ContextEngine is active.
5. **Decode the response.** The codec normalizes the assistant message into text + `ToolCall[]`. Malformed prompt-codec output throws `CodecError`; the kernel appends the codec's `repairPrompt` and retries (default 2 attempts via `maxDecodeRetries`).
6. **Stop or execute tools.** No tool calls → `turn_end(stop)` and the loop exits (unless steers/background tasks resurrect it). Otherwise all `tool_use` events are announced up front, then each call runs through the `wrapToolCall` chain — schema-validated, executed, and turned into a `ToolResult`. Up to `maxParallelTools` (default 10) run concurrently; tool-phase events stream live in completion order, while the model-facing message is assembled in input order.
7. **Feed results back** as one user message of `tool_result` blocks, yield `turn_end(tool_use)`, and loop — until `stop`, `aborted`, or `maxTurns`.
8. **Finish.** Run `afterAgent` hooks, yield `done` with the `RunResult` (`messages`, `text`, `usage`, `stopReason`).

:::tip
Abort is observed at turn boundaries: pass an `AbortSignal` via `run(input, { signal })` and the generator finishes with `done(reason: "aborted")`.
:::

## Drain semantics

Two properties matter when you consume or emit events:

- **Events are observational, not control flow.** Middleware and tools call `ctx.emit(ev)`; the kernel buffers those events in a queue and *drains* it at loop boundaries (after hooks, after the model call, before the next turn). Emitting never pauses the loop, and a slow consumer never blocks the kernel.
- **Interactive handlers block on their own I/O.** When an `ApprovalHandler` or `InputHandler` is in play, the kernel emits `approval_request` / `input_request` and then `await`s `handler.request(...)`. The loop genuinely parks on that promise — your CLI reads stdin, your web handler waits for a button click — and resumes when you resolve it. The event stream and the pause live in the same process; nothing is persisted mid-question.

During the tool phase the queue is replaced by a live channel so concurrent tools (and forwarded subagent events) surface in real time, in completion order.

## See also

- [Strategies](/core/strategies) — the roles that plug into each step.
- [Middleware](/core/middleware) — the hooks and wrappers the loop invokes.
- [Events](/core/events) — every event the loop yields.
- [Persistence](/core/persistence) — the `checkpointer` behind step 1.
