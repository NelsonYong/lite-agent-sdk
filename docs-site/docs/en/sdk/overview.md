# Agent SDK overview

`@lite-agent/sdk` is the batteries-included way to build agents with lite-agent: a working tool set, skills, subagents, persistent sessions, and a permission gate behind a small [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)-shaped API (`query` / `createLiteAgent` / `tool`). Pair it with a [`@lite-agent/provider`](/core/providers) for the model — every battery is a toggleable default over the core strategies, so you start productive and opt into control only where you need it.

## SDK vs Core

lite-agent is split into two layers:

- **`@lite-agent/sdk`** — the assembled agent. It wires the kernel's strategies into sensible defaults: built-in tools scoped to your workspace, an event-sourced session store, a permission middleware, skills and subagent loading. Use it when you want a working agent with a few lines of config.
- **`@lite-agent/core`** — the provider-agnostic kernel underneath: the turn loop, the nine strategy interfaces, the middleware onion, and the `AgentEvent` stream. It knows nothing about permissions, sandboxing, or skills — those are all plugged in. Use it directly when the SDK's assembly doesn't fit and you want to compose your own agent from kernel primitives.

The SDK re-exports all of `@lite-agent/core`, so you can drop down a level — write a custom strategy or middleware — without changing packages:

```ts
import { createLiteAgent, type Middleware } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

const logging: Middleware = {
  name: "logging",
  async wrapToolCall(ctx, next) {
    console.log(`→ ${ctx.call.name}`);
    const result = await next();
    console.log(`← ${ctx.call.name}${result.isError ? " (error)" : ""}`);
    return result;
  },
};

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  use: [logging], // extra middleware around the kernel loop
});
```

**Rule of thumb:** start with the SDK; reach for Core when you need to swap a strategy the SDK doesn't expose, reorder the middleware onion, or build a non-agent loop on the same primitives.

## Capability map

This section documents the SDK capability by capability:

| Page | What it covers |
| --- | --- |
| [Getting started](/sdk/getting-started) | Install to a permission-gated, multi-turn agent in four steps. |
| [Agent loop](/sdk/core-concepts/agent-loop) | How the kernel turn loop works — encode, stream, decode, tools, feed back. |
| [Sessions](/sdk/core-concepts/sessions) | Multi-turn sessions, persistence backends, and time travel. |
| [Events](/sdk/core-concepts/events) | The full `AgentEvent` stream: rendering text, approvals, and user input. |
| [Subagents](/sdk/tools/subagents) | Delegate context-heavy subtasks to isolated child agents. |
| [Permissions](/sdk/control/permissions) | Gate tool calls with allow / ask / deny policies and human approval. |
| [Checkpointing](/sdk/control/checkpointing) | Rewind a session's conversation and files to any earlier prompt. |

## See also

- [Getting started](/sdk/getting-started) — install and run your first agent.
- [Core strategies](/core/strategies) — the nine swappable parts the SDK assembles.
- [Model providers](/core/providers) — Anthropic, OpenAI, and OpenAI-compatible endpoints.
- [CLI example](/examples/cli) — a full interactive agent built on these APIs.
