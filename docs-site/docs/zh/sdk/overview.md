# Agent SDK 概览

`@lite-agent/sdk` 是用 lite-agent 构建 agent 的开箱即用方式：一套可用的内置工具、skills、子代理、持久化会话与权限闸门，对外是一个对齐 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) 的小巧 API（`query` / `createLiteAgent` / `tool`）。搭配 [`@lite-agent/provider`](/zh/core/providers) 提供模型——每一项"内置电池"都只是核心策略之上的可开关默认值：先用默认值跑起来，只在需要的地方接管控制权。

## SDK 与 Core

lite-agent 分为两层：

- **`@lite-agent/sdk`** —— 组装好的 agent。它把内核策略接成合理的默认配置：作用域限定在工作区的内置工具、事件溯源的会话存储、权限中间件、skills 与子代理加载。想要几行配置得到一个可用的 agent，用它。
- **`@lite-agent/core`** —— 底层的 provider 无关内核：轮次循环、九个策略接口、中间件洋葱、`AgentEvent` 流。它不懂权限、沙箱、skills——这些都是插进去的。当 SDK 的组装方式不合适、想直接用内核原语组合自己的 agent 时，用它。

SDK 完整转出 `@lite-agent/core`，因此你可以随时下沉一层——写自定义策略或中间件——而不需要换包：

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

**经验法则：** 从 SDK 开始；当需要替换 SDK 未暴露的策略、重排中间件洋葱、或在同一套原语上构建非 agent 的循环时，再转向 Core。

## 能力地图

本区按能力逐一介绍 SDK：

| 页面 | 内容 |
| --- | --- |
| [快速上手](/zh/sdk/getting-started) | 四步从安装到一个带权限闸门的多轮 agent。 |
| [代理循环](/zh/sdk/core-concepts/agent-loop) | 内核轮次循环如何工作——编码、流式、解码、工具、回灌。 |
| [会话](/zh/sdk/core-concepts/sessions) | 多轮会话、持久化后端与时间回溯。 |
| [事件](/zh/sdk/core-concepts/events) | 完整的 `AgentEvent` 流：渲染文本、审批与用户输入。 |
| [子代理](/zh/sdk/tools/subagents) | 把上下文密集的子任务委派给隔离的子代理。 |
| [权限](/zh/sdk/control/permissions) | 用 allow / ask / deny 策略与人工审批门控工具调用。 |
| [检查点](/zh/sdk/control/checkpointing) | 把会话的对话与文件回滚到任意历史 prompt。 |

## 另请参阅

- [快速上手](/zh/sdk/getting-started) —— 安装并运行你的第一个 agent。
- [核心策略](/zh/core/strategies) —— SDK 所组装的九个可替换部件。
- [模型 provider](/zh/core/providers) —— Anthropic、OpenAI 及 OpenAI 兼容端点。
- [CLI 示例](/zh/examples/cli) —— 基于这些 API 构建的完整交互式 agent。
