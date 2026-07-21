# @lite-agent/core

[English](./README.md) | **简体中文**

lite-agent 的可插拔、事件驱动 Agent 内核：一个精简、与具体模型无关的核心，由可替换的策略接口、洋葱式中间件管道和类型化事件流构成。用于基于原语搭建你自己的 Agent —— 如果需要开箱即用的组合（工具、技能、子 Agent、会话），请改用 [`@lite-agent/sdk`](../sdk)。

其公开 API 参照 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) 设计，但内核为自研，因此也能通过可插拔的 tool-call 编解码器（codec）驱动本地小模型。

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

## 特性

- **与提供商无关的内核** —— 对任何具体模型、权限 UI、存储方式一无所知；这些都是插进来的。
- **九个可替换策略** —— `ModelProvider` · `ToolCallCodec` · `Tool` · `Compactor` · `PermissionPolicy` · `ApprovalHandler` · `InputHandler` · `Store` · `Sandbox`。每个角色一个实现，可热插拔。
- **洋葱式中间件** —— 包裹模型调用与工具执行，另有生命周期钩子；声明式地组合各层。
- **类型化事件流** —— 每次运行都会产出 `AgentEvent`（`turn_start`、`text_delta`、`tool_use`、`tool_result`、`approval_request`、`compaction`、`done` ……），可观测性拉满。
- **上下文管理** —— 压缩工具箱（snip/micro pass、reactive trim、LLM 摘要器、token 预算、spill store）以及带 planner/archiver 钩子的 `ContextEngine`。
- **事件溯源检查点** —— 通过 `Checkpointer` 接口实现会话持久化与时间回溯；内置内存实现，持久化后端在兄弟包中。
- **权限中间件** —— 可组合的策略，支持规则匹配与敏感数据脱敏。
- **引导与后台任务** —— 用 `SteerController` 在运行中注入输入，用 `createBackgroundTasks` 派生 joinable 或 detached 工作，并通过结构化 completion 报告权威的 `BackgroundStatus`（`completed` / `partial` / `failed` / `cancelled`）。
- **可插拔沙箱** —— 默认 `noopSandbox`；操作系统级边界在 [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic)。
- **测试工具** —— `fakeProvider`，以及 provider 与 checkpointer 的一致性测试套件。

## API

| 符号 | 说明 |
| --- | --- |
| `createAgent` / `Agent` | 由策略组装 Agent；`run()` 流式产出事件，`send()` 等待 `RunResult`。 |
| `defineTool` / `toToolSpec` | 定义 zod 类型化的工具，并转换为面向模型的 spec。 |
| `nativeCodec` / `jsonCodec` / `reactCodec` | tool-call 编解码器：原生函数调用、JSON 提示、ReAct 文本。 |
| `composeModelCall` / `composeToolCall` / `runLifecycle` | 将中间件折叠到模型调用 / 工具执行上；运行生命周期钩子。 |
| `permission` / `policy` / `strictPolicy` / `composePolicies` / `defaultRedactor` | 权限中间件与可组合策略，支持脱敏。 |
| `retry` | 模型调用的重试中间件。 |
| `compaction` / `defaultCompactor` / `reactiveCompaction` / `reactiveTrim` / `llmCompactor` / `tokenBudgetCompactor` | 上下文压缩中间件与各类压缩器实现。 |
| `snipPass` / `microPass` / `splitTurns` / `runPipeline` / `estimateTokens` / `memorySpillStore` / `toolResultBudgetPass` | 自定义压缩流水线的构建块。 |
| `ContextEngine` / `createContextEngine` / `projectContext` | 自动上下文管理，带 planner/archiver 钩子与投影视图。 |
| `memoryCheckpointer` / `foldEvents` / `storeEvents` / `legacyStoreAdapter` / `memoryStore` | 事件溯源的会话持久化原语（内存实现）。 |
| `noopSandbox` | 默认的无边界沙箱。 |
| `SteerController` / `createBackgroundTasks` / `backgroundCompletionMessage` | 在运行中注入输入；派生/管理后台任务；将结构化 completion 映射为下一轮模型通知。 |
| `fakeProvider` / `checkpointerConformance` / `providerConformance` | 测试替身与一致性测试套件。 |
| `AgentError` + `ProviderError` / `ToolError` / `CodecError` / `MaxTurnsError` / `AbortError` / `CheckpointConflictError` | 错误层级。 |
| 类型：`ModelProvider`、`ToolCallCodec`、`Tool`、`Compactor`、`PermissionPolicy`、`ApprovalHandler`、`InputHandler`、`Store`、`Sandbox`、`Message`、`ContentBlock`、`AgentEvent`、`RunResult`、`BackgroundStatus`、`BackgroundRunResult`、`BackgroundCompletion` 等 | 全部策略接口、归一化消息类型、后台生命周期结果和事件联合类型。 |

## 相关

- [`@lite-agent/sdk`](../sdk) —— 在本内核之上组装的开箱即用 Agent（工具、技能、子 Agent、会话、权限门）。
- [`@lite-agent/provider`](../provider) —— `ModelProvider` 实现（`anthropic()` / `openai()`）。
- [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) —— 持久化的 `Checkpointer` 后端。
- [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic) —— 操作系统级沙箱边界。
- [`@lite-agent/local`](../local) —— 本地小模型支持。
- [Monorepo 根目录](../..) —— 完整架构说明。
