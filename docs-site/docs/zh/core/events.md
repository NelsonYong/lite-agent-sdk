# 事件

内核的每次运行都产出一条单一的类型化流：`AgentEvent`——一个覆盖循环一切动作的可辨识联合类型：模型调用、工具执行、审批、压缩、错误以及最终结果。这就是你在 lite-agent 之上构建 UI、日志和遥测的方式：消费这条流并渲染它。事件*只做观察*——处理事件绝不改变 agent 行为。

## 用法

用 `agent.run(...)` 消费事件流，按 `ev.type` 判别：

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

for await (const ev of agent.run("hello")) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

从子代理转发的事件带 `agentId`；主 agent 的事件不带。

## `AgentEvent` 联合类型

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

:::info
非致命失败（重试的模型调用、codec 修复尝试）在抛出之前会先以 `{ type: "error", fatal: false }` 事件出现，观察者能看到完整过程。
:::

## 发出你自己的事件

中间件和工具可以通过 `ctx.emit(ev)` 发事件；内核把这些事件缓冲进队列，在循环边界统一 drain。emit 永远不会暂停循环，消费端再慢也不会阻塞内核——见 [drain 语义](/zh/core/kernel#drain-语义)。

## 另请参阅

- [内核](/zh/core/kernel) —— 产生这条流的循环，以及 drain 语义。
- [中间件](/zh/core/middleware) —— `ctx.emit` 与观察循环的各层。
- [上下文压缩](/zh/core/compaction) —— `compaction` 与 `context_status` 事件。
- [持久化](/zh/core/persistence) —— 会话回放背后的持久 `SessionEvent` 日志。
