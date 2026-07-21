# 后台任务

开启 `background: true`（默认）后，长期 `createLiteAgent()` 会持有 session 范围的
后台工作。只需订阅一次即可观察普通用户轮次、child 事件和自主 completion 轮次；调用
`close()` 会取消仍在运行的工作并释放 session runner。

```ts
const agent = createLiteAgent({ model, workdir: process.cwd() });
const unsubscribe = agent.subscribe(({ sessionId, source, event }) => {
  render(sessionId, source, event);
});

await agent.send("派发代码审查");
await agent.send("它运行期间先回答另一个问题");

unsubscribe();
await agent.close();
```

## Bash 与 Agent 的生命周期不同

- **`bash` 带 `run_in_background: true`** 会启动 detached 进程，立即返回 `bg_…`
  id。用 `BashOutput` 读取增量输出，用 `KillBackground` 取消；它仍适用于 daemon。
- **`Agent`** 每次都会注册一个 detached 子代理组。其 `run_in_background` 输入只为
  兼容解析，不能使组恢复为同步；`background: false` 则会让 Agent 派发明确失败。

一个 Agent group 只会在所有 child settle 后发出一次聚合的
`background_completed` 事件。随后所属 session 被唤醒，运行一次自主 completion；同一
session 的用户轮次和 completion 轮次串行执行。

`query()` 有意保持有限：关闭临时 agent 前，它会等待自己创建的 Agent groups 及其
自主 completion；不会等待不相关的 detached Bash daemon。若发起轮次返回后仍需交互，
请选择 `createLiteAgent()`。

## 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `background` | `true` | 总开关。`false` 会移除 `BashOutput` / `KillBackground`，并使 Agent 派发失败。 |
| `backgroundLimits` | — | session 后台 handle 与 detached Bash 输出的限制。 |
| `maxParallelSubagents` | `5` | 同一根 agent 的所有 group 共用的 child kernel FIFO 上限。 |

`backgroundLimits` 字段：

| 字段 | 说明 |
| --- | --- |
| `maxTotal` | 后台 handle 总数上限。 |
| `maxJoinable` | 底层 joinable handle 上限；Agent group 是 detached。 |
| `maxDetached` | detached handle 上限。 |
| `bufferBytes` | 每个 detached task 的输出环形缓冲大小（默认 1 MB，丢弃最旧）。 |
| `maxTaskMs` | 后台任务最长墙钟时间。 |

## Completion 状态

在 `background_completed` 中查看 `event.completion.status`，它是权威结果。`completed`
表示全部 child 成功；`partial` 会同时保留成功输出和失败诊断；`failed`、`cancelled`
都不是成功。兼容字段 `isError` 由 `status !== "completed"` 派生。

```ts
for await (const event of query({ /* … */ })) {
  if (event.type === "background_completed") {
    console.log(event.completion.status, event.completion.content);
  }
}
```

## 内置控制工具

| 工具 | 说明 |
| --- | --- |
| `BashOutput` | 按 `bg_…` id 读取后台 `bash` 命令的增量输出。 |
| `KillBackground` | 按 id 取消存活的后台 handle。 |

两者仅在 `background` 开启时注册，也可用 `allowedTools` / `disallowedTools` 过滤。

## 另请参阅

- [子代理](/zh/sdk/tools/subagents)——任务命名、组级送达与 pool 语义。
- [Core 后台生命周期](/zh/core/background)——状态和 XML 通知映射。
- [可观测性](/zh/sdk/control/observability)——消费 `background_completed` 事件。
