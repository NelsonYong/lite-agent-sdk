# 核心概念

三个概念可以解释 lite-agent 的全部：**内核轮次循环**、可替换的九种**策略**、以及包裹其外的洋葱式**中间件** —— 外加一条观察一切的**事件**流。

## 内核轮次循环

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

## 九种策略

策略是*可替换的部件*：每个角色一个实现，在构建 agent 时注入。

| 策略 | 职责 |
| --- | --- |
| `ModelProvider` | 流式返回模型响应 —— 来自 `@lite-agent/provider` 的 `anthropic()` / `openai()`，或测试用的 `fakeProvider`。 |
| `ToolCallCodec` | 把工具规格编码进请求、从回复中解码工具调用 —— `nativeCodec` / `jsonCodec` / `reactCodec`。 |
| `Tool` | 模型可调用的、以 Zod 定型入参的具名能力。 |
| `Compactor` | 上下文溢出时压缩对话。 |
| `PermissionPolicy` | 对每个工具调用给出 `allow` / `deny` / `ask` 裁决。 |
| `ApprovalHandler` | 应答 `ask` 裁决 —— 人工询问或自动批准器。 |
| `InputHandler` | 应答模型在运行中发出的 `ask_user` 提问。 |
| `Store` | 持久化会话数据。 |
| `Sandbox` | 包裹 shell 命令，使其运行在 OS 级边界内；默认为 `noopSandbox`。 |

**何时需要自定义：** 换部件，而不是改内核。本地小模型 → `jsonCodec()` 或 `reactCodec()`；托管权限 → `composePolicies(...)`；持久会话 → `@lite-agent/checkpoint-sqlite` 的 `Checkpointer`。只有当内置实现和兄弟包都覆盖不了某个角色时，才自己去实现接口。

## 洋葱中间件

中间件是*加在循环上的横切层* —— `Middleware` 接口提供生命周期钩子（`beforeAgent` / `afterAgent` / `beforeModel`）和两个包裹器：包裹每次模型调用的 `wrapModelCall`、包裹每次工具执行的 `wrapToolCall`。

```ts
import type { Middleware } from "@lite-agent/core";

const logging: Middleware = {
  name: "logging",
  async wrapToolCall(ctx, next) {
    console.log(`→ ${ctx.call.name}`);
    const result = await next();
    console.log(`← ${ctx.call.name}${result.isError ? " (error)" : ""}`);
    return result;
  },
};
```

**折叠顺序。** `composeModelCall(mws, ctx, base)` 与 `composeToolCall(mws, ctx, base)` 用 `reduceRight` 折叠：**数组中第一个中间件是最外层** —— 进入时它最先看到调用，返回时最后看到结果。

```
use: [A, B, C]
        │
   A ──► B ──► C ──► base tool/model call
   A ◄── B ◄── C ◄── result
```

**权限就是一个中间件。** `@lite-agent/core` 的 `permission(policy, approval?)` 返回一个 `Middleware`，其 `wrapToolCall` 在调用 `next()` 之前先向 `PermissionPolicy` 要裁决 —— `deny` 直接短路，`ask` 把调用挂起在 `ApprovalHandler` 上。门控没有任何硬编码进内核的部分；你可以像对待其他任何层一样重排、替换或包裹它。

## 事件

每次运行产出一条类型化的 `AgentEvent` 流 —— *只做观察*：处理事件绝不改变 agent 行为。从子代理转发的事件带 `agentId`；主 agent 的事件不带。

| 事件 | 载荷 | 触发时机 |
| --- | --- | --- |
| `turn_start` | `turn` | 一轮开始。 |
| `model_call_start` | `turn`, `model` | 一次模型调用开始。 |
| `model_call_end` | `turn`, `model`, `durationMs`, `usage?`, `error?` | 一次模型调用结束（或失败）。 |
| `text_delta` | `text` | 流式文本块到达。 |
| `message` | `message` | 本轮完整的 assistant 消息就绪。 |
| `tool_use` | `call` | 模型请求了一次工具调用。 |
| `tool_call_start` | `call`, `turn` | 一个工具调用开始执行。 |
| `tool_call_end` | `id`, `name`, `turn`, `durationMs`, `isError` | 一个工具调用结束。 |
| `tool_recovered` | `id`, `name`, `turn` | 恢复会话时收尾了被中断的调用（安全崩溃恢复）。 |
| `tool_result` | `result` | 工具结果回灌进对话。 |
| `permission_decision` | `call`, `decision`, `ruleId?`, `reason?`, `simulated?`, `by` | 权限层作出 `allow` / `deny` / `ask` 裁决（`by`：`policy` / `user` / `auto`）。 |
| `approval_request` | `call`, `reason?` | `ask` 裁决把调用挂起等待审批。 |
| `approval_resolved` | `id`, `decision`, `by` | 审批处理器给出答复。 |
| `input_request` | `call`, `question` | 模型向用户提问（`ask_user`）。 |
| `input_resolved` | `id`, `answer` | 输入处理器给出答复。 |
| `steer` | `messages` | 通过 `SteerController` 在运行中注入了输入。 |
| `compaction` | `kind`, `before`, `after`, `phase?` | 上下文压缩开始 / 完成（`micro` / `auto` / `manual`）。 |
| `context_status` | `sessionId`, `level`, `reason`, `beforeTokens`, `afterTokens`, `generation`, `plannerUsed`, `plannerFallback`, `plannerLatencyMs`, `archiveRefs`, `retry` | `ContextEngine` 报告自动上下文管理状态。 |
| `background_completed` | `completion` | 一个后台任务完成。 |
| `diagnostic` | `level`, `code`, `message` | 非致命诊断（info / warning / error）。 |
| `turn_end` | `turn`, `stopReason` | 一轮结束（`stop` / `tool_use` / `max_tokens`）。 |
| `error` | `error`, `fatal` | 发生 `AgentError`；`fatal` 会终止运行。 |
| `done` | `reason`, `result` | 运行结束（`stop` / `aborted` / `max_turns`），携带最终 `RunResult`。 |

## 下一步

- [`@lite-agent/core`](/zh/packages/core) —— 策略接口、中间件辅助函数、codec、压缩工具箱。
- [`@lite-agent/sdk`](/zh/packages/sdk) —— 这些原语如何组装成开箱即用的 agent。
