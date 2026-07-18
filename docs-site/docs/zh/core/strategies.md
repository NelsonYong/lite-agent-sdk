# 策略

内核的每个活动部件都是策略接口——每个角色一个实现，在构建 agent 时可热插拔。这就是 lite-agent 做到 provider 无关、宿主无关的方式：不换内核，换部件。九个接口全部以类型形式从 `@lite-agent/core` 导出。

## 用法

通过 `KernelConfig` 把实现传给 `createAgent`——或者接受默认值，只覆盖你关心的角色：

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});
```

**何时需要自定义：** 换部件，而不是改内核。本地小模型 → `jsonCodec()` 或 `reactCodec()`；托管权限 → `composePolicies(...)`；持久会话 → 后端包的 `Checkpointer`。只有当内置实现和兄弟包都覆盖不了某个角色时，才自己去实现接口。

## 九种策略

### `ModelProvider`

为 `ModelRequest` 流式产出归一化的 `ModelChunk`（`text_delta` + 终止性的 `message_done`）。纯适配器：只懂厂商 API，不懂工具语义。还可暴露可选的 `context` 能力（`contextWindow`、`countTokens`、`clearToolUses`、`clearThinking`、`compact`、`promptCache`），ContextEngine 会优先使用它们而非本地 pass。

**自定义场景：** 把公司内部的推理网关包在 `stream()` 后面，整个内核——工具、checkpoint、中间件——原样可用。见 [Providers](/zh/core/providers)。

### `ToolCallCodec`

把工具规格编码进请求，并把 assistant 消息解码回 `{ text, calls }`。基于 prompt 的 codec 声明 `streaming: "buffer"`，并可提供解码失败后使用的 `repairPrompt`。

**自定义场景：** 你微调的本地模型说一种自定义的 `<<tool:...>>` 语法——实现 `encode`/`decode` 插进来即可。见[工具调用 codec](/zh/core/codecs)。

### `Tool`

zod 类型化的可调用体：`{ name, description, schema, security?, execute(input, ctx) }`。用 `defineTool` 定义，用 `toToolSpec` 转成面向模型的规格。内核在 `execute` 运行前先用 `schema` 校验输入；`ToolContext` 携带 `sessionId`、`signal`、`emit`，以及可选的 `approval` / `input` / `sandbox` / `background` 句柄。

```ts
import { defineTool } from "@lite-agent/core";
import { z } from "zod";

const weather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});
```

**自定义场景：** 把内部搜索 API 暴露成工具——五行代码，端到端全类型。

### `Compactor`

`maybeCompact(messages, usage, instructions?) → CompactResult`——决定是否以及如何压缩对话。`instructions` 用于引导手动 compaction（类似 Claude Code 的 `/compact <instructions>`）；结构性 compactor 会忽略它。

**自定义场景：** 一个领域感知的 compactor，永远保留提到未关闭 Jira 工单的消息。见[上下文压缩](/zh/core/compaction)。

### `PermissionPolicy`

`check(call, ctx) → "allow" | "deny" | "ask"`（或带规则溯源信息的 `PolicyVerdict`）。它只能看到身份标识——`ToolCall` 和 `sessionId`——拿不到 `emit` 和 `signal`。用 `policy`、`strictPolicy`、`composePolicies` 组合策略，用 `permission` 中间件把守执行。

**自定义场景：** 拒绝任何参数触及工作区之外文件的工具调用。

### `ApprovalHandler`

`request(call) → Promise<"allow" | "deny">`。当策略回答 `ask` 时被调用；循环一直停到你 resolve。拒绝会转成合成的 `isError` 工具结果——工具根本不会执行。

**自定义场景：** 在托管部署中把审批路由到 Slack 按钮。

### `InputHandler`

`request(question: UserQuestion) → Promise<UserAnswer>`。与审批对称的另一面：模型主动提问（通过 ask-user 工具），handler 用自由文本或选项作答。

**自定义场景：** 无头运行时，从配置文件读取答案而不是交互提问。

### `Store`

遗留的整组消息持久化接缝：`load(id)` / `save(id, messages)`。已被事件溯源的 `Checkpointer` 取代；传入的 `Store` 会通过 `legacyStoreAdapter` 自动适配。

**自定义场景：** 你已经把对话记录存在 Postgres——保留你的 `Store`，内核会自动适配。见[持久化](/zh/core/persistence)。

### `Sandbox`

把 shell 命令包进 OS 级边界运行：`wrap(command, { cwd })`，外加可选的 `initialize`/`dispose`。默认是 `noopSandbox()`——完全没有边界。

**自定义场景：** 让所有 shell 工具命令跑在按会话创建的 Docker 容器里。

## 另请参阅

- [内核](/zh/core/kernel) —— 每种策略插入循环的位置。
- [中间件](/zh/core/middleware) —— 循环外层的层，包括 `permission` 闸门。
- [Providers](/zh/core/providers) —— 现成的 `ModelProvider` 实现。
- [Codec](/zh/core/codecs) —— `nativeCodec` / `jsonCodec` / `reactCodec`。
- [持久化](/zh/core/persistence) —— `Checkpointer` 后端。
