# @lite-agent/core

**English** | [简体中文](./README.zh-CN.md)

The pluggable, event-driven agent kernel for lite-agent: a lean, provider-agnostic core built from swappable strategy interfaces, an onion middleware pipeline, and a typed event stream. Use it to build your own agent from primitives — for a batteries-included setup (tools, skills, subagents, sessions), use [`@lite-agent/sdk`](../sdk) instead.

Its public API is shaped after [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript), but the kernel is self-built, so it can also drive local small models via pluggable tool-call codecs.

## Install

```bash
pnpm add @lite-agent/core zod
```

## Quick start

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

// Stream typed events…
for await (const ev of agent.run("hello")) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}

// …or await the final result.
const result = await agent.send("hello");
console.log(result.text);
```

`fakeProvider` is a built-in test double. For a real model, pass a `ModelProvider` from [`@lite-agent/provider`](../provider) (`anthropic()` / `openai()`).

## Features

- **Provider-agnostic kernel** — knows nothing about any specific model, permission UI, or storage; those are plugged in.
- **Nine swappable strategies** — `ModelProvider` · `ToolCallCodec` · `Tool` · `Compactor` · `PermissionPolicy` · `ApprovalHandler` · `InputHandler` · `Store` · `Sandbox`. One implementation per role, hot-swappable.
- **Onion middleware** — wrap model calls and tool executions, plus lifecycle hooks; compose layers declaratively.
- **Typed event stream** — every run yields `AgentEvent`s (`turn_start`, `text_delta`, `tool_use`, `tool_result`, `approval_request`, `compaction`, `done`, …) for full observability.
- **Context management** — compaction toolkit (snip/micro passes, reactive trim, LLM summarizer, token budgets, spill store) and a `ContextEngine` with planner/archiver hooks.
- **Event-sourced checkpoints** — session persistence and time-travel via the `Checkpointer` interface; in-memory implementation included, durable backends in sibling packages.
- **Permission middleware** — composable policies with rule matching and sensitive-data redaction.
- **Steering & background tasks** — inject input mid-run with `SteerController`, spawn joinable or detached work with `createBackgroundTasks`, and report authoritative `BackgroundStatus` (`completed` / `partial` / `failed` / `cancelled`) through structured completions.
- **Pluggable sandbox** — default `noopSandbox`; an OS-level boundary lives in [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic).
- **Testing utilities** — `fakeProvider` plus conformance suites for providers and checkpointers.

## API

| Symbol | Description |
| --- | --- |
| `createAgent` / `Agent` | Assemble an agent from strategies; `run()` streams events, `send()` awaits the `RunResult`. |
| `defineTool` / `toToolSpec` | Define zod-typed tools and convert them to model-facing specs. |
| `nativeCodec` / `jsonCodec` / `reactCodec` | Tool-call codecs: native function calling, JSON prompting, ReAct text. |
| `composeModelCall` / `composeToolCall` / `runLifecycle` | Fold middleware around model calls / tool executions; run lifecycle hooks. |
| `permission` / `policy` / `strictPolicy` / `composePolicies` / `defaultRedactor` | Permission middleware and composable policies with redaction. |
| `retry` | Retry middleware for model calls. |
| `compaction` / `defaultCompactor` / `reactiveCompaction` / `reactiveTrim` / `llmCompactor` / `tokenBudgetCompactor` | Context compaction middleware and compactor implementations. |
| `snipPass` / `microPass` / `splitTurns` / `runPipeline` / `estimateTokens` / `memorySpillStore` / `toolResultBudgetPass` | Building blocks for custom compaction pipelines. |
| `ContextEngine` / `createContextEngine` / `projectContext` | Automatic context management with planner/archiver hooks and projected views. |
| `memoryCheckpointer` / `foldEvents` / `storeEvents` / `legacyStoreAdapter` / `memoryStore` | Event-sourced session persistence primitives (in-memory). |
| `noopSandbox` | The default no-boundary sandbox. |
| `SteerController` / `createBackgroundTasks` / `backgroundCompletionMessage` | Inject input mid-run; spawn/manage background tasks; map a structured completion into the next model notification. |
| `fakeProvider` / `checkpointerConformance` / `providerConformance` | Test double and conformance test suites. |
| `AgentError` + `ProviderError` / `ToolError` / `CodecError` / `MaxTurnsError` / `AbortError` / `CheckpointConflictError` | Error hierarchy. |
| Types: `ModelProvider`, `ToolCallCodec`, `Tool`, `Compactor`, `PermissionPolicy`, `ApprovalHandler`, `InputHandler`, `Store`, `Sandbox`, `Message`, `ContentBlock`, `AgentEvent`, `RunResult`, `BackgroundStatus`, `BackgroundRunResult`, `BackgroundCompletion`, … | All strategy interfaces, normalized message types, background lifecycle results, and the event union. |

## Related

- [`@lite-agent/sdk`](../sdk) — batteries-included agent composed from this core (tools, skills, subagents, sessions, permission gate).
- [`@lite-agent/provider`](../provider) — `ModelProvider` implementations (`anthropic()`, `openai()`).
- [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) — durable `Checkpointer` backend.
- [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic) — OS-level sandbox boundary.
- [`@lite-agent/local`](../local) — local-model support.
- [Monorepo root](../..) — full architecture write-up.
