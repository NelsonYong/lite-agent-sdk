# Core concepts

Three ideas explain all of lite-agent: the **kernel turn loop**, the nine **strategies** you can swap, and the **middleware** onion you can wrap around it — with the **event** stream observing everything.

## The kernel turn loop

Each turn, the kernel (`@lite-agent/core`) runs the same five steps:

```
┌──────────────────────── one turn ────────────────────────┐
│  1. encode  messages + tool specs ──► ModelRequest       │
│  2. stream  provider.stream(req) ──► text_delta events   │
│  3. decode  assistant message ──► { text, tool calls }   │
│  4. run each tool call through the middleware chain      │
│  5. feed tool results back into the conversation         │
└───────────────── loop until stop / maxTurns ─────────────┘
```

1. **Encode** — the conversation plus tool specs are encoded into a provider-shaped request by the `ToolCallCodec`.
2. **Stream** — the `ModelProvider` streams chunks back; text surfaces as `text_delta` events in real time.
3. **Decode** — the codec decodes the finished assistant message into text and structured `ToolCall`s (`{ id, name, input }`). Malformed output from weak models triggers codec repair retries.
4. **Tool middleware chain** — every tool call runs through the `wrapToolCall` onion (permission, logging, your own layers) before its result is produced.
5. **Feed back** — tool results are appended to the conversation and the loop starts the next turn, until the model stops or `maxTurns` is reached.

The kernel itself knows nothing about permissions, sandboxing, or compaction — those are strategies and middleware plugged into this loop.

## Nine strategies

A strategy is a *swappable part*: one implementation per role, resolved at agent construction.

| Strategy | Role |
| --- | --- |
| `ModelProvider` | Streams model responses — `anthropic()` / `openai()` from `@lite-agent/provider`, or `fakeProvider` in tests. |
| `ToolCallCodec` | Encodes tool specs into the request and decodes tool calls from the reply — `nativeCodec` / `jsonCodec` / `reactCodec`. |
| `Tool` | A named, Zod-typed capability the model can call. |
| `Compactor` | Shrinks the conversation when context overflows. |
| `PermissionPolicy` | Returns an `allow` / `deny` / `ask` verdict per tool call. |
| `ApprovalHandler` | Answers `ask` verdicts — a human prompt, or an auto-approver. |
| `InputHandler` | Answers the model's `ask_user` questions mid-run. |
| `Store` | Persists session data. |
| `Sandbox` | Wraps shell commands so they run inside an OS-level boundary; default is `noopSandbox`. |

**When to customize:** swap, don't fork. A local small model → `jsonCodec()` or `reactCodec()`; managed permissions → `composePolicies(...)`; durable sessions → the `Checkpointer` from `@lite-agent/checkpoint-sqlite`. Write your own implementation of an interface only when the built-ins and sibling packages don't cover that role.

## Onion middleware

A middleware is an *added layer* around the loop — the `Middleware` interface offers lifecycle hooks (`beforeAgent` / `afterAgent` / `beforeModel`) and two wrappers: `wrapModelCall` around each model call, `wrapToolCall` around each tool execution.

```ts
import type { Middleware } from "@lite-agent/core";

const logging: Middleware = {
  name: "logging",
  async wrapToolCall(ctx, next) {
    console.log(`→ ${ctx.call.name}`);
    const result = await next();
    console.log(`← ${ctx.call.name}${result.isError ? " (error)" : ""}`);
    return result;
  },
};
```

**Fold order.** `composeModelCall(mws, ctx, base)` and `composeToolCall(mws, ctx, base)` fold with `reduceRight`: the **first middleware in the array is the outermost layer** — it sees the call first on the way in and last on the way out.

```
use: [A, B, C]
        │
   A ──► B ──► C ──► base tool/model call
   A ◄── B ◄── C ◄── result
```

**Permission is just a middleware.** `permission(policy, approval?)` from `@lite-agent/core` returns a `Middleware` whose `wrapToolCall` asks the `PermissionPolicy` for a verdict before invoking `next()` — `deny` short-circuits the call, `ask` suspends it on the `ApprovalHandler`. Nothing about gating is hard-coded in the kernel; you could reorder, replace, or wrap that layer like any other.

## Events

Every run yields a typed `AgentEvent` stream — *observe only*: handling events never changes agent behavior. Events forwarded from a subagent carry an `agentId`; the main agent's events don't.

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

## Next steps

- [`@lite-agent/core`](/packages/core) — strategy interfaces, middleware helpers, codecs, compaction toolkit.
- [`@lite-agent/sdk`](/packages/sdk) — how these primitives are assembled into a batteries-included agent.
