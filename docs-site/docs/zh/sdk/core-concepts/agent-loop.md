# 代理循环

每次运行——一次性的 `query()` 或 `LiteAgent` 上的一次 `send()`——都由同一个内核**轮次循环**驱动：编码对话、流式调用模型、执行请求的工具、把结果回灌、重复。理解这个循环，SDK 里的其他一切就都有了答案：权限、沙箱、压缩都不是写死在 agent 里的特例——它们是插进这五个步骤的策略与中间件。

循环本身不需要配置；你通过[事件](/zh/sdk/core-concepts/events)观察它，通过替换策略或添加中间件来定制它。

## 一轮如何工作

每一轮，内核（`@lite-agent/core`）执行同样的五个步骤：

```
┌──────────────────────── one turn ────────────────────────┐
│  1. encode  messages + tool specs ──► ModelRequest       │
│  2. stream  provider.stream(req) ──► text_delta events   │
│  3. decode  assistant message ──► { text, tool calls }   │
│  4. run each tool call through the middleware chain      │
│  5. feed tool results back into the conversation         │
└───────────────── loop until stop / maxTurns ─────────────┘
```

1. **编码（Encode）** —— 对话历史加工具规格由 `ToolCallCodec` 编码成 provider 形状的请求。
2. **流式（Stream）** —— `ModelProvider` 流式返回数据块；文本以 `text_delta` 事件实时透出。
3. **解码（Decode）** —— codec 把完成的 assistant 消息解码为文本和结构化的 `ToolCall`（`{ id, name, input }`）。弱模型的畸形输出会触发 codec 修复重试。
4. **工具中间件链** —— 每个工具调用在产出结果前都要穿过 `wrapToolCall` 洋葱（权限、日志、你自己的层）。
5. **结果回灌** —— 工具结果追加进对话，循环进入下一轮，直到模型停止或达到 `maxTurns`。

内核本身不懂权限、沙箱、压缩 —— 它们都是插进这个循环的策略与中间件。

## SDK 在哪里插入

| 循环步骤 | `@lite-agent/sdk` 的默认值 | 定制方式 |
| --- | --- | --- |
| 编码 / 解码 | `nativeCodec()` | `codec` 选项——如对弱模型用 `jsonCodec()` / `reactCodec()`。 |
| 流式 | 来自 `@lite-agent/provider` 的 `ModelProvider` | `model` + `modelName` 选项；采样参数 `maxTokens`、`temperature`、`topP`、`toolChoice`、`seed`。 |
| 工具中间件链 | 权限闸门 + 内置工具 | `permission` / `onApproval`，`use: [...]` 额外中间件。 |
| 循环上限 | — | `maxTurns` 限制单次运行的对话轮数。 |

**权限就是一个中间件。** 闸门位于 `wrapToolCall` 洋葱之中：`deny` 直接短路调用，`ask` 把调用挂起在你的 `onApproval` 处理器上。门控没有任何硬编码进内核的部分；你可以像对待其他任何层一样重排、替换或包裹它。

:::tip
**换部件，而不是改内核。** 本地小模型 → `jsonCodec()` 或 `reactCodec()`；托管权限 → `composePolicies(...)`；持久会话 → `@lite-agent/checkpoint-sqlite` 的 `Checkpointer`。只有当内置实现和兄弟包都覆盖不了某个角色时，才自己去实现接口。
:::

## 另请参阅

- [事件](/zh/sdk/core-concepts/events) —— 以类型化流观察循环的每一步。
- [会话](/zh/sdk/core-concepts/sessions) —— 轮次如何累积成持久对话。
- [核心策略](/zh/core/strategies) —— 九个可替换策略接口的详细介绍。
- [权限](/zh/sdk/control/permissions) —— SDK 默认安装的权限中间件。
