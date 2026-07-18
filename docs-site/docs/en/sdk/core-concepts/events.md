# Events

Every run yields a typed `AgentEvent` stream — the single channel for streaming text to a UI, showing tool activity, and servicing approvals and user questions. Events are **observe only**: handling them never changes agent behavior, so you can build any rendering or logging layer on top without touching the agent.

You already consume the stream whenever you iterate `query()`:

```ts
import { query } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

for await (const ev of query({
  prompt: "Summarize this project.",
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  cwd: process.cwd(),
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

Events forwarded from a subagent carry an `agentId`; the main agent's events don't.

## Rendering text

Text arrives incrementally as `text_delta` chunks — write them through for a streaming UI. When a turn's full assistant message is ready, a `message` event carries it; when the whole run finishes, `done` carries the final `RunResult`:

```ts
for await (const ev of query({ /* ... */ })) {
  switch (ev.type) {
    case "text_delta":
      process.stdout.write(ev.text);       // stream chunks as they arrive
      break;
    case "tool_call_start":
      console.error(`\n[tool] ${ev.call.name}`);
      break;
    case "error":
      if (ev.fatal) console.error(ev.error);
      break;
  }
}
```

## Interactive events: approvals and user input

Two event pairs correspond to points where the run **suspends** and waits for your handler:

- `approval_request` → `approval_resolved` — the permission gate returned `ask` for a tool call; your `onApproval` handler answers `"allow"` or `"deny"`. See [Permissions](/sdk/control/permissions).
- `input_request` → `input_resolved` — the model called `ask_user`; your `onAskUser` handler returns the answer string.

Use the events to render the prompt in your UI (e.g. show *which* tool call is awaiting approval); use the handlers to actually answer. The run blocks until the handler resolves.

## Full event reference

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

## See also

- [Agent loop](/sdk/core-concepts/agent-loop) — the five steps that produce these events.
- [Sessions](/sdk/core-concepts/sessions) — events are what gets persisted per session.
- [Permissions](/sdk/control/permissions) — the approval flow behind `approval_request` / `approval_resolved`.
- [Core strategies](/core/strategies) — `ApprovalHandler` and `InputHandler` interfaces.
