# 内核

内核是 `@lite-agent/core` 的心脏——轮次循环：编码 → 调模型 → 解码 → 执行 → 回灌，循环往复直到模型停止。理解它的回报无处不在：它精确告诉你策略插在哪一步、中间件包在哪一层、事件在何时发出。内核本身不懂权限和压缩——它们都是中间件。循环本体只剩「编码 → 调模型 → 解码 → 执行 → 回灌」。

## 用法

`createAgent(config)` 把配置装配成 `KernelConfig`，返回一个带两个入口的 `Agent`：

- `run(input, opts?)` —— 异步生成器，产出每一个 `AgentEvent`，并最终返回 `RunResult`。
- `send(input, opts?)` —— 排空同一个生成器，只 resolve `RunResult`。

两者都通过 `RunOptions` 接受 `{ signal, sessionId, steer }`。

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

for await (const ev of agent.run("hello", { signal: AbortSignal.timeout(30_000) })) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

## 一次运行，逐步解析

1. **加载会话。** 配置了 `checkpointer` 时，回放事件日志并用 `foldEvents` 重建消息列表；`crashRecovery: "safe"` 时，已开始但未完成的工具会补一条合成的错误 `tool_result`。
2. **运行 `beforeAgent` 钩子**（每次运行一次），随后排空事件队列。
3. **开启一轮** —— 产出 `turn_start`，应用待处理的 steer 和后台任务完成通知，然后运行 `beforeModel` 钩子（compaction 中间件就挂在这里）。
4. **调用模型。** 请求由 `ToolCallCodec` 编码，流经 `wrapModelCall` 中间件链，文本以 `text_delta` 事件透出。在产出任何 chunk 之前发生上下文溢出错误时，若 ContextEngine 处于激活状态，会触发一次紧急 compaction 并重试。
5. **解码响应。** codec 把 assistant 消息归一化为文本 + `ToolCall[]`。prompt codec 输出格式错误会抛 `CodecError`；内核追加 codec 的 `repairPrompt` 并重试（默认 2 次，由 `maxDecodeRetries` 控制）。
6. **停止或执行工具。** 没有工具调用 → `turn_end(stop)` 并退出循环（除非 steer/后台任务让它复活）。否则先按输入顺序产出全部 `tool_use` 事件，然后每个调用走 `wrapToolCall` 链——schema 校验、执行、转成 `ToolResult`。最多 `maxParallelTools`（默认 10）个并发执行；工具阶段事件按完成顺序实时流出，而面向模型的消息仍按输入顺序组装。
7. **回灌结果**：把所有结果块组装成一条 user 消息，产出 `turn_end(tool_use)`，继续循环——直到 `stop`、`aborted` 或达到 `maxTurns`。
8. **收尾。** 运行 `afterAgent` 钩子，产出携带 `RunResult`（`messages`、`text`、`usage`、`stopReason`）的 `done` 事件。

:::tip
abort 只在轮次边界被观察：通过 `run(input, { signal })` 传入 `AbortSignal`，生成器会以 `done(reason: "aborted")` 收尾。
:::

## drain 语义

消费或发送事件时有两条关键性质：

- **事件是观察性的，不是控制流。** 中间件和工具调用 `ctx.emit(ev)`；内核把这些事件缓冲进队列，在循环边界（钩子之后、模型调用之后、下一轮之前）统一 *drain*。emit 永远不会暂停循环，消费端再慢也不会阻塞内核。
- **交互 handler 自行阻塞自己的 I/O。** 当有 `ApprovalHandler` 或 `InputHandler` 参与时，内核先发出 `approval_request` / `input_request` 事件，然后 `await handler.request(...)`。循环确实停在这个 Promise 上——你的 CLI 读 stdin、web handler 等按钮点击——resolve 之后循环恢复。事件流和中断发生在同一进程内，提问过程中没有任何东西被持久化。

工具执行阶段，队列会被替换为实时 channel，使并发工具（以及转发的子代理事件）按完成顺序实时透出。

## 另请参阅

- [策略](/zh/core/strategies) —— 插入每个步骤的角色。
- [中间件](/zh/core/middleware) —— 循环调用的钩子与包装器。
- [事件](/zh/core/events) —— 循环产出的全部事件。
- [持久化](/zh/core/persistence) —— 第 1 步背后的 `checkpointer`。
