# lite-agent

**English** | [简体中文](./README.zh-CN.md)

A pluggable, lightweight **agent-core SDK**, structured as a pnpm monorepo. The kernel is provider-agnostic and built from swappable **strategy** interfaces + an onion **middleware** pipeline + a typed **event** stream. Its public API is shaped after [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) (`query` / `tool` / `allowedTools`), but the kernel is self-built so it can also drive local small models via pluggable tool-call codecs.

## Packages

| Package | Description |
| --- | --- |
| [`@lite-agent/local`](./packages/local) | Strict single-host runtime: local models, SQLite, mandatory sandbox, managed permissions, resource limits, and local audit logs. |
| [`@lite-agent/sdk`](./packages/sdk) | Batteries-included agent: tools, skills, subagents, tasks, sessions, system prompt — `query()` / `createLiteAgent()` / `tool()`. |
| [`@lite-agent/core`](./packages/core) | The kernel: strategy interfaces, middleware pipeline, normalized types, codecs, permission, sandbox, checkpointer primitives. |
| [`@lite-agent/provider`](./packages/provider) | Model providers — Anthropic Messages API + OpenAI Chat Completions (also OpenAI-compatible / local endpoints). |
| [`@lite-agent/sandbox-anthropic`](./packages/sandbox-anthropic) | OS-level `Sandbox` adapter (macOS Seatbelt / Linux bubblewrap). |
| [`@lite-agent/checkpoint-sqlite`](./packages/checkpoint-sqlite) | SQLite (WAL) `Checkpointer` — single-host, multi-process session persistence. |

Plus [`examples/cli`](./examples/cli) — an interactive REPL demo wiring the full stack.

## Quick start

```bash
pnpm add @lite-agent/sdk @lite-agent/provider zod
```

```ts
import { query } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

for await (const ev of query({
  prompt: "List the files here and summarize what this project does.",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  cwd: process.cwd(),
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

See [`@lite-agent/sdk`](./packages/sdk) for `createLiteAgent`, tools, permissions, and sessions.

## Architecture

- **Kernel** (`core`) — each turn: encode the request → stream from the provider → decode tool calls → run each through the tool-call middleware chain → feed results back → loop until the model stops or `maxTurns`. It knows nothing about permissions, sandboxing, or compaction — those are plugged in.
- **Strategy** — *swap a part*: `ModelProvider`, `ToolCallCodec`, `Tool`, `Compactor`, `PermissionPolicy`, `ApprovalHandler`, `InputHandler`, `Store`, `Sandbox`.
- **Middleware** — *add a layer*: retry, permission, logging, compaction — via `wrapModelCall` / `wrapToolCall` and lifecycle hooks.
- **Event** — *observe only*: a typed `AgentEvent` stream from `run()` for logging / UI / metrics.

## Development

This repo is a pnpm workspace (pnpm ≥ 10.12.4, Node ≥ 20). From the root:

```bash
pnpm build       # pnpm -r build  — each package via tsup → dist/ (ESM + d.ts)
pnpm test        # pnpm -r test   — vitest
pnpm typecheck   # pnpm -r typecheck
pnpm dev         # run the interactive CLI example
```

> Packages import each other via their built `dist/`, so after changing a package's source, rebuild it before testing a dependent. Full check: `pnpm -r build && pnpm -r test && pnpm -r typecheck`.

## License

ISC
