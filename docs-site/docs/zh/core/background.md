# 后台生命周期

`createBackgroundTasks()` 是 Core 提供的生命周期原语，用于有限的 joinable 工作和
detached 工作。SDK 的子代理组把它作为 session 持有的 detached handle 使用；Core 本身
不定义子代理调度或 UI 语义。

## 结构化结果与状态

后台 `run` 可返回兼容的旧 `string` 结果，也可返回结构化的
`BackgroundRunResult`：

```ts
type BackgroundStatus = "completed" | "partial" | "failed" | "cancelled";

type BackgroundRunResult = {
  content: string;
  status: BackgroundStatus;
};
```

旧 string 保持兼容，按 `{ content, status: "completed" }` 处理。当任务本身有聚合
生命周期（例如混合结果的子代理组）时，应返回结构化结果。

每个 completion 都是结构化的 `BackgroundCompletion`：

```ts
type BackgroundCompletion = {
  id: string;
  label: string;
  content: string;
  status: BackgroundStatus;
  isError: boolean;
  awaitIdle?: boolean;
};
```

`status` 是权威字段。`isError` 为兼容保留，并由它派生：仅 `completed` 为 `false`，
`partial`、`failed`、`cancelled` 都是 `true`。`done` 事件只表示模型轮次结束，不表示
后台任务成功；消费者应检查 `background_completed.completion.status`。

## 面向模型的通知映射

`backgroundCompletionMessage()` 把 completion 转为下一轮模型输入的 user message。XML
status 属性保持既有的成功格式，非成功状态映射如下：

| `BackgroundCompletion.status` | XML 属性 |
| --- | --- |
| `completed` | 省略 |
| `partial` | `status="partial"` |
| `failed` | `status="error"` |
| `cancelled` | `status="cancelled"` |

```xml
<background-task-completed id="bg_…" label="Subagent group: API 审查" status="partial">
## API 审查 (agentId: agent-reviewer-…; status: completed)
…结果…

## 安全审查 (agentId: agent-general-purpose-…; status: failed)
Error: Subagent reached max turns
</background-task-completed>
```

label 是展示文本，id 才是用于取消或追踪的 handle。Core 不会从 content 推断成功与否：
聚合 child 工作的调用方必须提供结构化 status。

## Kind 与送达

`kind: "joinable"` 是有限底层工作的默认值：kernel 在 dry-out 时等待它，并注入完成
通知。`kind: "detached"` 永不阻塞 run 结束，并可通过 `read()` 获取增量输出。registry
还提供 `cancel()`、`cancelAll()`、completion 收集与可配置限制。session owner 可提供
外部持有的 registry，以便在后续轮次送达 detached completion。

`BackgroundSpawnOptions.awaitIdle` 是 session 级等待提示，不是送达开关。默认值为
`true`。设为 `false` 后，该 completion 不会延长 `LiteAgent.awaitIdle()` 和一次性
`query()` 的收拢时间；只要 session 仍打开，completion event 与 autonomous delivery
仍会照常发生。SDK 的 Agent 组显式使用 `awaitIdle: true`，detached Bash daemon 使用
`awaitIdle: false`。只有主动退出等待的任务才会在 completion 上携带
`awaitIdle: false`；默认情况为兼容性而省略该字段。

## 另请参阅

- [SDK 后台任务](/zh/sdk/control/background)——session 持有与交互式使用。
- [子代理](/zh/sdk/tools/subagents)——pooled detached group 语义。
