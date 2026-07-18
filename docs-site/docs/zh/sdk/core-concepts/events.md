# 事件

每次运行产出一条类型化的 `AgentEvent` 流——它是向 UI 流式输出文本、展示工具活动、以及服务审批与用户提问的唯一通道。事件**只做观察**：处理事件绝不改变 agent 行为，因此你可以在其上构建任意渲染或日志层，而不必触碰 agent。

每次迭代 `query()` 时你已经在消费这条流：

```ts
import { query } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

for await (const ev of query({
  prompt: "Summarize this project.",
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  cwd: process.cwd(),
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

从子代理转发的事件带 `agentId`；主 agent 的事件不带。

## 渲染文本

文本以 `text_delta` 块增量到达——直接写出即可获得流式 UI。当一轮的完整 assistant 消息就绪时发出 `message` 事件；整个运行结束时，`done` 携带最终的 `RunResult`：

```ts
for await (const ev of query({ /* ... */ })) {
  switch (ev.type) {
    case "text_delta":
      process.stdout.write(ev.text);       // stream chunks as they arrive
      break;
    case "tool_call_start":
      console.error(`\n[tool] ${ev.call.name}`);
      break;
    case "error":
      if (ev.fatal) console.error(ev.error);
      break;
  }
}
```

## 交互事件：审批与用户输入

有两对事件对应运行**挂起**、等待你的处理器应答的时机：

- `approval_request` → `approval_resolved` —— 权限闸门对某个工具调用返回 `ask`；你的 `onApproval` 处理器回答 `"allow"` 或 `"deny"`。见[权限](/zh/sdk/control/permissions)。
- `input_request` → `input_resolved` —— 模型调用了 `ask_user`；你的 `onAskUser` 处理器返回答案字符串。

用事件在 UI 中渲染提示（例如展示*哪个*工具调用在等待审批）；用处理器给出真正的回答。处理器 resolve 之前，运行一直阻塞。

## 完整事件参考

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

## 另请参阅

- [代理循环](/zh/sdk/core-concepts/agent-loop) —— 产生这些事件的五个步骤。
- [会话](/zh/sdk/core-concepts/sessions) —— 事件正是每个会话被持久化的内容。
- [权限](/zh/sdk/control/permissions) —— `approval_request` / `approval_resolved` 背后的审批流程。
- [核心策略](/zh/core/strategies) —— `ApprovalHandler` 与 `InputHandler` 接口。
