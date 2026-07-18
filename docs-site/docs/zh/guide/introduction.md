# 介绍

**lite-agent** 是一个可插拔、轻量的 **agent 内核 SDK**，运行于 Node ≥ 20。它的内核与 provider 无关，由三部分构成：可替换的**策略（strategy）**接口、洋葱式**中间件（middleware）**管道、类型化**事件（event）**流。

## 为什么存在

- **Provider 无关** —— 内核对任何具体模型、权限 UI、存储一无所知。Anthropic、OpenAI 或 OpenAI 兼容的本地端点，都只是插进同一个循环的 `ModelProvider` 实现。
- **自研内核，可驱动本地小模型** —— 模型供应商与「工具调用编码」解耦。不支持原生 function calling 的弱模型，可以通过可插拔 codec（`nativeCodec` / `jsonCodec` / `reactCodec`）适配，同一个 agent 因此也能跑在本地小模型上。
- **熟悉的公开 API** —— 参照 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)（`query` / `tool` / `allowedTools`）。用过那个 SDK 就已经会驱动 lite-agent；区别在于 API 之下的一切都可替换。

## 整体架构

每一轮（turn），内核执行同一个循环：**编码**请求 → 从 provider **流式**读取 → **解码**工具调用 → 逐个穿过**工具调用中间件链** → 把结果**回灌** —— 如此往复，直到模型停止或达到 `maxTurns`。

```
for await (const ev of agent.run("…"))        ← typed AgentEvent stream out
        │
┌───────▼────────────── one turn ──────────────────────────┐
│  encode request ──► stream model ──► decode tool calls   │
│        ▲                                     │           │
│  feed results back ◄── tool middleware chain ◄┘          │
└────────────────── loop until stop / maxTurns ────────────┘
```

内核本身不懂权限、沙箱、压缩 —— 这些都通过三层扩展点插入：

| 层 | 助记 | 是什么 |
| --- | --- | --- |
| **策略（Strategy）** | *换一个部件* | 九个接口 —— `ModelProvider`、`ToolCallCodec`、`Tool`、`Compactor`、`PermissionPolicy`、`ApprovalHandler`、`InputHandler`、`Store`、`Sandbox`。每个角色一个实现，热插拔。 |
| **中间件（Middleware）** | *加一层横切* | 包裹模型调用与工具执行的洋葱层（`wrapModelCall` / `wrapToolCall`）加生命周期钩子 —— 重试、权限、日志、压缩，以及你自己的。 |
| **事件（Event）** | *只做观察* | 每次运行产出的类型化 `AgentEvent` 流 —— 用于日志、UI、指标。观察绝不改变行为。 |

## 包一览

| 包 | 说明 |
| --- | --- |
| [`@lite-agent/sdk`](/zh/packages/sdk) | 开箱即用的 agent：工具、技能、子代理、任务、会话、系统提示词 —— `query()` / `createLiteAgent()` / `tool()`。 |
| [`@lite-agent/core`](/zh/packages/core) | 内核：策略接口、中间件管道、规范化类型、codec、权限、沙箱、checkpointer 原语。 |
| [`@lite-agent/provider`](/zh/packages/provider) | 模型 provider —— Anthropic Messages API + OpenAI Chat Completions（含 OpenAI 兼容 / 本地端点）。 |
| [`@lite-agent/sandbox-anthropic`](/zh/packages/sandbox-anthropic) | OS 级 `Sandbox` 适配器（macOS Seatbelt / Linux bubblewrap）。 |
| [`@lite-agent/checkpoint-sqlite`](/zh/packages/checkpoint-sqlite) | SQLite（WAL）`Checkpointer` —— 单机多进程的会话持久化。 |
| [`@lite-agent/local`](/zh/packages/local) | 严格单机运行时：本地模型、SQLite、强制沙箱、托管权限、资源限额、本地审计日志。 |

:::tip
大多数应用从 `@lite-agent/sdk` + `@lite-agent/provider` 起步。当你想用原语自己组装 agent 时，再下沉到 `@lite-agent/core`。
:::

下一步：[快速上手](/zh/guide/getting-started) —— 安装并运行你的第一个 `query()`。
