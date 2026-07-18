# 内核概览

`@lite-agent/core` 是 lite-agent 的可插拔、事件驱动 agent 内核：一个精简、provider 无关的核心，由可替换的策略接口、洋葱中间件管道和类型化事件流构成。当你想从原语出发自己组装 agent——完全掌控模型、工具、持久化以及中间的每一层——而不是魔改某个框架时，用它。它的公开 API 参照 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) 设计，但内核是自研的，因此也能通过可插拔的工具调用 codec 驱动本地小模型。

## 快速开始

```bash
pnpm add @lite-agent/core zod
```

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

`fakeProvider` 是内置的测试替身。接入真实模型时，传入一个 `ModelProvider`——见 [Providers](/zh/core/providers)。

## 三个词记住设计

内核里的一切都属于三个概念之一：

- **策略（Strategy）** —— *可替换的部件*，每个角色一个实现，在构建 agent 时注入。共九种：`ModelProvider`、`ToolCallCodec`、`Tool`、`Compactor`、`PermissionPolicy`、`ApprovalHandler`、`InputHandler`、`Store`、`Sandbox`。换部件，不改内核。见[策略](/zh/core/strategies)。
- **中间件（Middleware）** —— *加在循环上的横切层*。生命周期钩子加两个包装器（`wrapModelCall`、`wrapToolCall`）折叠成经典洋葱；权限和压缩都只是中间件，不是内核代码。见[中间件](/zh/core/middleware)。
- **事件（Event）** —— 类型化的 `AgentEvent` 流观察循环做的一切。事件是观察性的，永远不是控制流。见[事件](/zh/core/events)。

把三者串起来的循环——编码 → 调模型 → 解码 → 执行 → 回灌——见[内核](/zh/core/kernel)。

## Core 与 SDK 的关系

core 默认不懂权限、压缩和会话——它们都是你插进来的策略和中间件。[@lite-agent/sdk](/zh/sdk/overview) 是同一个内核的开箱即用组装：内置工具、技能、子代理、会话和权限门控，ContextEngine 开箱即启用。当 SDK 的默认值不合适——内部推理网关、定制工具调用协议、自有持久化后端——想自己接线原语时，用 core。

## 另请参阅

- [内核](/zh/core/kernel) —— 轮次循环逐步解析与 drain 语义。
- [策略](/zh/core/strategies) —— 九个可替换角色。
- [中间件](/zh/core/middleware) —— 洋葱模型与内置中间件。
- [事件](/zh/core/events) —— 完整的 `AgentEvent` 参考。
- [SDK 概览](/zh/sdk/overview) —— 基于本内核构建的开箱即用 agent。
