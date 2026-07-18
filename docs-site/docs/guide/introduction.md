# Introduction

**lite-agent** is a pluggable, lightweight **agent-core SDK** for Node ≥ 20. Its kernel is provider-agnostic and built from three parts: swappable **strategy** interfaces, an onion **middleware** pipeline, and a typed **event** stream.

## Why it exists

- **Provider-agnostic** — the kernel knows nothing about any specific model, permission UI, or storage. Anthropic, OpenAI, or an OpenAI-compatible local endpoint are all just `ModelProvider` implementations plugged into the same loop.
- **A self-built kernel that drives local small models** — the model supplier is decoupled from the *tool-call encoding*. Weaker models that can't do native function calling are adapted through pluggable codecs (`nativeCodec` / `jsonCodec` / `reactCodec`), so the same agent runs on a local small model.
- **A familiar public API** — shaped after [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) (`query` / `tool` / `allowedTools`). If you've used that SDK, you already know how to drive lite-agent; what differs is that everything under the API is replaceable.

## Architecture

Each turn, the kernel runs one loop: **encode** the request → **stream** from the provider → **decode** tool calls → run each through the **tool-call middleware chain** → **feed results back** — and repeat until the model stops or `maxTurns` is hit.

```
for await (const ev of agent.run("…"))        ← typed AgentEvent stream out
        │
┌───────▼────────────── one turn ──────────────────────────┐
│  encode request ──► stream model ──► decode tool calls   │
│        ▲                                     │           │
│  feed results back ◄── tool middleware chain ◄┘          │
└────────────────── loop until stop / maxTurns ────────────┘
```

The kernel itself knows nothing about permissions, sandboxing, or compaction — those are plugged in through the three extension layers:

| Layer | Mnemonic | What it is |
| --- | --- | --- |
| **Strategy** | *swap a part* | Nine interfaces — `ModelProvider`, `ToolCallCodec`, `Tool`, `Compactor`, `PermissionPolicy`, `ApprovalHandler`, `InputHandler`, `Store`, `Sandbox`. One implementation per role, hot-swappable. |
| **Middleware** | *add a layer* | Onion wrappers around model calls and tool executions (`wrapModelCall` / `wrapToolCall`) plus lifecycle hooks — retry, permission, logging, compaction, your own. |
| **Event** | *observe only* | A typed `AgentEvent` stream out of every run — for logging, UI, and metrics. Observation never changes behavior. |

## Packages

| Package | Description |
| --- | --- |
| [`@lite-agent/sdk`](/packages/sdk) | Batteries-included agent: tools, skills, subagents, tasks, sessions, system prompt — `query()` / `createLiteAgent()` / `tool()`. |
| [`@lite-agent/core`](/packages/core) | The kernel: strategy interfaces, middleware pipeline, normalized types, codecs, permission, sandbox, checkpointer primitives. |
| [`@lite-agent/provider`](/packages/provider) | Model providers — Anthropic Messages API + OpenAI Chat Completions (also OpenAI-compatible / local endpoints). |
| [`@lite-agent/sandbox-anthropic`](/packages/sandbox-anthropic) | OS-level `Sandbox` adapter (macOS Seatbelt / Linux bubblewrap). |
| [`@lite-agent/checkpoint-sqlite`](/packages/checkpoint-sqlite) | SQLite (WAL) `Checkpointer` — single-host, multi-process session persistence. |
| [`@lite-agent/local`](/packages/local) | Strict single-host runtime: local models, SQLite, mandatory sandbox, managed permissions, resource limits, and local audit logs. |

:::tip
Most apps start from `@lite-agent/sdk` + `@lite-agent/provider`. Drop to `@lite-agent/core` when you want to assemble your own agent from primitives.
:::

Next: [Getting started](/guide/getting-started) — install and run your first `query()`.
