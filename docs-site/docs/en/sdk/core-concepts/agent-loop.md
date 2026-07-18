# Agent loop

Every run — a one-shot `query()` or a `send()` on a `LiteAgent` — is driven by the same kernel **turn loop**: encode the conversation, stream the model, run the requested tools, feed the results back, repeat. Understanding the loop explains everything else in the SDK: permissions, sandboxing, and compaction are not special cases hard-coded into the agent — they are strategies and middleware plugged into these five steps.

You don't configure the loop itself; you observe it through [events](/sdk/core-concepts/events) and customize it by swapping strategies or adding middleware.

## How a turn works

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

## Where the SDK plugs in

| Loop step | Default in `@lite-agent/sdk` | How to customize |
| --- | --- | --- |
| Encode / decode | `nativeCodec()` | `codec` option — e.g. `jsonCodec()` / `reactCodec()` for weaker models. |
| Stream | `ModelProvider` from `@lite-agent/provider` | `model` + `modelName` options; sampling via `maxTokens`, `temperature`, `topP`, `toolChoice`, `seed`. |
| Tool middleware chain | Permission gate + built-in tools | `permission` / `onApproval`, `use: [...]` extra middleware. |
| Loop bound | — | `maxTurns` caps conversation turns per run. |

**Permission is just a middleware.** The gate sits in the `wrapToolCall` onion: `deny` short-circuits the call, `ask` suspends it on your `onApproval` handler. Nothing about gating is hard-coded in the kernel; you could reorder, replace, or wrap that layer like any other.

:::tip
**Swap, don't fork.** A local small model → `jsonCodec()` or `reactCodec()`; managed permissions → `composePolicies(...)`; durable sessions → the `Checkpointer` from `@lite-agent/checkpoint-sqlite`. Write your own implementation of an interface only when the built-ins and sibling packages don't cover that role.
:::

## See also

- [Events](/sdk/core-concepts/events) — observe every step of the loop as a typed stream.
- [Sessions](/sdk/core-concepts/sessions) — how turns accumulate into a persistent conversation.
- [Core strategies](/core/strategies) — the nine swappable strategy interfaces in detail.
- [Permissions](/sdk/control/permissions) — the permission middleware the SDK installs by default.
