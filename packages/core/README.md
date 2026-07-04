# @lite-agent/core

**English** | [简体中文](./README.zh-CN.md)

The pluggable, event-driven agent kernel. A lean, provider-agnostic core built from swappable **strategy** interfaces, an onion **middleware** pipeline, and a typed **event** stream. It knows nothing about any specific model, permission UI, or storage — those are plugged in.

Its public API is shaped after [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript), but the kernel is self-built so it can also drive local small models via pluggable tool-call codecs.

For a batteries-included setup (real tools, skills, subagents, sessions, permission gate), use [`@lite-agent/sdk`](../sdk) — it composes this core. Reach for `@lite-agent/core` directly when you want to build your own agent from the primitives.

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

## The kernel

`runKernel(cfg, input, signal, sessionId)` is an `async function*` yielding `AgentEvent`s. Each turn: `codec.encode` the request → `provider.stream` (wrapped by `wrapModelCall` middleware) → accumulate text/usage → `codec.decode` into tool calls → run each through the `wrapToolCall` chain around `tool.execute` → feed results back → loop until the model stops calling tools or `maxTurns` is hit. Abort is observed at turn boundaries.

## Nine swappable strategies

One implementation per role, hot-swappable:

`ModelProvider` · `ToolCallCodec` · `Tool` · `Compactor` · `PermissionPolicy` · `ApprovalHandler` · `InputHandler` · `Store` · `Sandbox`.

## Design mnemonic

- **Strategy** — *swap a part*: `ModelProvider`, `ToolCallCodec`, `Tool`, `Compactor`, `PermissionPolicy`, `ApprovalHandler`, `InputHandler`, `Store`, `Sandbox`.
- **Middleware** — *add a layer*: `wrapModelCall`, `wrapToolCall`, and lifecycle hooks (`beforeAgent` / `afterAgent` / `beforeModel`). Fold with `composeModelCall` / `composeToolCall`.
- **Event** — *observe only*: a typed `AgentEvent` stream (`turn_start`, `text_delta`, `message`, `tool_use`, `tool_result`, `approval_request|resolved`, `input_request|resolved`, `compaction`, `turn_end`, `error`, `done`).

## What's exported

- **Assembly** — `createAgent`, `defineTool` / `toToolSpec`, `nativeCodec`.
- **Middleware** — `permission` + `policy`, `retry`, `compaction` and the compaction toolkit (`defaultCompactor`, `reactiveCompaction`, `llmCompactor`, spill store, …), `composeModelCall` / `composeToolCall`.
- **Persistence** — event-sourced `Checkpointer` primitives: `memoryCheckpointer`, `foldEvents`, `storeEvents`, `legacyStoreAdapter`, plus `memoryStore`. (For durable backends see [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) or the SDK's file checkpointer.)
- **Sandbox** — `noopSandbox` (the default no-boundary sandbox; OS-level boundary lives in [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic)).
- **Steering** — `SteerController` for injecting input mid-run.
- **Errors** — `AgentError` + `ProviderError` / `ToolError` / `CodecError` / `MaxTurnsError` / `AbortError` / `CheckpointConflictError`.
- **Testing** — `fakeProvider`, `checkpointerConformance`.
- **Types** — normalized `Message` / `ContentBlock` / `ToolCall` / `ToolResult` / `UserQuestion` / `UserAnswer`, all strategy interfaces, and the `AgentEvent` union.

See the [monorepo root](../..) for the full architecture write-up.
