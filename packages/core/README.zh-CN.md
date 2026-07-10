# @lite-agent/core

[English](./README.md) | **简体中文**

可插拔、事件驱动的 Agent 内核。一个精简、与具体模型无关的核心，由可替换的**策略（strategy）**接口、洋葱式**中间件（middleware）**管道，以及类型化的**事件（event）**流构成。它对任何具体模型、权限 UI、存储方式一无所知 —— 这些都是插进来的。

其公开 API 参照 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) 设计，但内核为自研，因此也能通过可插拔的 tool-call 编解码器（codec）驱动本地小模型。

若需要开箱即用的组合（真实工具、技能、子 Agent、会话、权限门），请用 [`@lite-agent/sdk`](../sdk) —— 它就是在本内核之上组装出来的。当你想用这些原语自己搭建 Agent 时，才直接使用 `@lite-agent/core`。

## 安装

```bash
pnpm add @lite-agent/core zod
```

## 快速开始

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

// 流式消费类型化事件……
for await (const ev of agent.run("hello")) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}

// ……或等待最终结果。
const result = await agent.send("hello");
console.log(result.text);
```

`fakeProvider` 是内置的测试替身。要接真实模型，请传入来自 [`@lite-agent/provider`](../provider) 的 `ModelProvider`（`anthropic()` / `openai()`）。

## 内核

`runKernel(cfg, input, signal, sessionId)` 是一个产出 `AgentEvent` 的 `async function*`。每一轮：`codec.encode` 编码请求 → `provider.stream`（被 `wrapModelCall` 中间件包裹）→ 累积文本 / 用量 → `codec.decode` 解码出 tool 调用 → 每个调用穿过 `wrapToolCall` 链、包裹 `tool.execute` 执行 → 把结果回灌 → 循环，直到模型不再调用工具或达到 `maxTurns`。中断（abort）在轮次边界被观测。

## 九个可替换策略

每个角色一个实现，可热插拔：

`ModelProvider` · `ToolCallCodec` · `Tool` · `Compactor` · `PermissionPolicy` · `ApprovalHandler` · `InputHandler` · `Store` · `Sandbox`。

## 设计口诀

- **策略（Strategy）**——*替换某个部件*：`ModelProvider`、`ToolCallCodec`、`Tool`、`Compactor`、`PermissionPolicy`、`ApprovalHandler`、`InputHandler`、`Store`、`Sandbox`。
- **中间件（Middleware）**——*叠加一层*：`wrapModelCall`、`wrapToolCall`，以及生命周期钩子（`beforeAgent` / `afterAgent` / `beforeModel`）。用 `composeModelCall` / `composeToolCall` 折叠。
- **事件（Event）**——*只观察*：一个类型化的 `AgentEvent` 流（`turn_start`、`text_delta`、`message`、`tool_use`、`tool_result`、`approval_request|resolved`、`input_request|resolved`、`compaction`、`turn_end`、`error`、`done`）。

## 导出内容

- **组装** —— `createAgent`、`defineTool` / `toToolSpec`、`nativeCodec`、`jsonCodec`、`reactCodec`。
- **中间件** —— `permission` + `policy`、`retry`、`compaction` 及压缩工具箱（`defaultCompactor`、`reactiveCompaction`、`llmCompactor`、spill store 等）、`composeModelCall` / `composeToolCall`。
- **持久化** —— 事件溯源的 `Checkpointer` 原语：`memoryCheckpointer`、`foldEvents`、`storeEvents`、`legacyStoreAdapter`，以及 `memoryStore`。（持久化后端见 [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) 或 SDK 的文件 checkpointer。）
- **沙箱** —— `noopSandbox`（默认的无边界沙箱；操作系统级边界在 [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic)）。
- **引导（Steering）** —— `SteerController`，用于在运行中注入输入。
- **错误** —— `AgentError` + `ProviderError` / `ToolError` / `CodecError` / `MaxTurnsError` / `AbortError` / `CheckpointConflictError`。
- **测试** —— `fakeProvider`、`checkpointerConformance`。
- **类型** —— 归一化的 `Message` / `ContentBlock` / `ToolCall` / `ToolResult` / `UserQuestion` / `UserAnswer`，全部策略接口，以及 `AgentEvent` 联合类型。

完整架构说明见 [monorepo 根目录](../..)。
