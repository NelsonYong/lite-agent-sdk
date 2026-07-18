# Events

Every run of the kernel yields a single typed stream: `AgentEvent`, a discriminated union covering everything the loop does — model calls, tool executions, approvals, compaction, errors, and the final result. This is how you build UIs, logs, and telemetry on top of lite-agent: consume the stream and render it. Events are *observe only* — handling an event never changes agent behavior.

## Usage

Consume the stream with `agent.run(...)` and discriminate on `ev.type`:

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

for await (const ev of agent.run("hello")) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

Events forwarded from a subagent carry an `agentId`; the main agent's events don't.

## The `AgentEvent` union

| Event | Payload | Emitted when |
| --- | --- | --- |
| `turn_start` | `turn` | A turn begins. |
| `model_call_start` | `turn`, `model` | A model call starts. |
| `model_call_end` | `turn`, `model`, `durationMs`, `usage?`, `error?` | A model call finishes (or fails). |
| `text_delta` | `text` | A streamed text chunk arrives. |
| `message` | `message` | The full assistant message for a turn is complete. |
| `tool_use` | `call` | The model requested a tool call. |
| `tool_call_start` | `call`, `turn` | A tool call starts executing. |
| `tool_call_end` | `id`, `name`, `turn`, `durationMs`, `isError` | A tool call finishes. |
| `tool_recovered` | `id`, `name`, `turn` | An interrupted call is closed on resume (safe crash recovery). |
| `tool_result` | `result` | A tool result is fed back into the conversation. |
| `permission_decision` | `call`, `decision`, `ruleId?`, `reason?`, `simulated?`, `by` | The permission layer decides `allow` / `deny` / `ask` (`by`: `policy` / `user` / `auto`). |
| `approval_request` | `call`, `reason?` | An `ask` verdict suspends the call for approval. |
| `approval_resolved` | `id`, `decision`, `by` | The approval handler answered. |
| `input_request` | `call`, `question` | The model asks the user a question (`ask_user`). |
| `input_resolved` | `id`, `answer` | The input handler answered. |
| `steer` | `messages` | Input was injected mid-run via a `SteerController`. |
| `compaction` | `kind`, `before`, `after`, `phase?` | Context compaction starts / finishes (`micro` / `auto` / `manual`). |
| `context_status` | `sessionId`, `level`, `reason`, `beforeTokens`, `afterTokens`, `generation`, `plannerUsed`, `plannerFallback`, `plannerLatencyMs`, `archiveRefs`, `retry` | The `ContextEngine` reports automatic context management. |
| `background_completed` | `completion` | A background task finished. |
| `diagnostic` | `level`, `code`, `message` | Non-fatal diagnostics (info / warning / error). |
| `turn_end` | `turn`, `stopReason` | A turn ends (`stop` / `tool_use` / `max_tokens`). |
| `error` | `error`, `fatal` | An `AgentError` occurs; `fatal` ends the run. |
| `done` | `reason`, `result` | The run finishes (`stop` / `aborted` / `max_turns`) with the final `RunResult`. |

:::info
Non-fatal failures (a retried model call, a codec repair attempt) surface as `{ type: "error", fatal: false }` events before any throw, so observers see the full story.
:::

## Emitting your own events

Middleware and tools can emit through `ctx.emit(ev)`; the kernel buffers those events in a queue and drains it at loop boundaries. Emitting never pauses the loop, and a slow consumer never blocks the kernel — see [drain semantics](/core/kernel#drain-semantics).

## See also

- [The kernel](/core/kernel) — the loop that produces this stream, and drain semantics.
- [Middleware](/core/middleware) — `ctx.emit` and the layers that observe the loop.
- [Context compaction](/core/compaction) — the `compaction` and `context_status` events.
- [Persistence](/core/persistence) — the durable `SessionEvent` log behind session replay.
