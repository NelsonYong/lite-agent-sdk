# 任务清单

任务通过 `TaskCreate`、`TaskUpdate`、`TaskGet`、`TaskList` 四个工具记录工作及执行结果。默认启用，数据保存在项目对应的 SDK 数据目录中。

## 作用域

每个会话默认独享列表，子代理共享父会话的列表。需要跨会话共享时显式设置 `taskListId` 或 `LITE_AGENT_TASK_LIST_ID`。旧的 `default` 列表可用 `taskListId: "default"` 重新打开。`tasks: false` 会关闭任务跟踪及提醒。

## 状态与执行

| 状态 | 含义 |
| --- | --- |
| `pending` | 尚未开始，可能仍在等待依赖。 |
| `in_progress` | 正在处理。 |
| `review` | 子代理执行成功，结果仍待验收。 |
| `completed` | 已检查并确认满足任务目标。 |
| `failed` | 执行失败，重试前应检查结果。 |
| `cancelled` | 执行已取消。 |

`Agent` 派发会自动创建任务；提供 `task_id` 可关联已有任务。`owner` 和 `execution.agentId` 标识执行者，`execution.result` 保存结果或错误。一个任务只能有一个活跃子代理，模型不能在它运行时提前标记完成。子代理成功后，用 `TaskGet` 检查结果，再通过 `TaskUpdate` 标记为 `completed`。

`TaskUpdate` 可以修改任务字段并添加 `blockedBy`/`blocks` 依赖边。循环依赖会被拒绝；前置任务未完成时，不能进入 `in_progress`、`review` 或 `completed`。依赖不会自动触发调度，父 Agent 决定何时派发已就绪的任务。

写入使用文件锁和原子文件替换。任务数据可跨重启保留，但进程崩溃后的活跃子代理不会自动恢复。恢复前应检查遗留的 `in_progress` 任务；持久化任务清单不等于持久化作业调度器。

## 模型提醒与界面

每轮提醒展示活跃、待验收和失败任务，省略已完成和已取消任务；`TaskList` 仍返回完整列表。提醒不会写入对话记录。订阅 `task_update` 可观察状态变化，订阅 `model_call_start` 可看到实际模型及请求的推理强度。

```ts
const agent = createLiteAgent({ model, workdir });
const unsubscribe = agent.subscribe(({ event }) => {
  if (event.type === "task_update") console.log(event.taskId, event.status);
});
try {
  await agent.send("派发两个独立检查，随后验收结果。");
  await agent.awaitIdle();
} finally {
  unsubscribe();
  await agent.close();
}
```
