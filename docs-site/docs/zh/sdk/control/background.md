# 后台任务

耗时的工作不必阻塞 agent。开启 `background: true`（默认即开启）后，agent 可以把慢命令和子代理批次拆到后台任务里，前台继续干活，结果出来时再取。增量输出轮询、取消、每个任务完成时的 `background_completed` 事件——全部经由常规事件流暴露。

## 用法

无需配置——后台任务默认开启。由模型按次调用决定是否使用：

- **`bash` 带 `run_in_background: true`** 以分离模式运行——立即返回一个 `bg_…` id，不阻塞 run 结束。用 `BashOutput` 工具轮询增量输出；run 结束时进程会被自动停止。
- **`Agent` 带 `run_in_background: true`**（需显式开启；默认阻塞）把一批子代理作为一个**可汇合（joinable）**任务派发——run 会存活到它完成，聚合结果以 `<background-task-completed>` 通知的形式送达。
- **`KillBackground`** 按 id 取消任意运行中的后台任务。

```xml
<background-task-completed id="bg_…" label="…">
…aggregated result…
</background-task-completed>
```

分离 vs. 可汇合：**分离（detached）**任务（后台 `bash`）是即发即弃的——run 可以在它运行期间结束，届时它会被停止。**可汇合（joinable）**任务（后台 `Agent`）会让 run 存活到它完成，因此结果必定送达。

## `background_completed` 事件

每个任务完成时，会向 run 的事件流发射一个 `background_completed` 事件（并像其他事件一样持久化进会话日志）：

```ts
for await (const ev of query({ /* … */ })) {
  if (ev.type === "background_completed") {
    console.log(ev.completion.id, ev.completion.content);
  }
}
```

这让后台完成通知对 UI 和审计 sink 可见——见[可观测性](/zh/sdk/control/observability)。

## 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `background` | `true` | 总开关。`false` 关闭该能力并移除 `BashOutput` / `KillBackground` 工具。 |
| `backgroundLimits` | — | 后台任务的上限（见下）。 |

`backgroundLimits` 字段：

| 字段 | 说明 |
| --- | --- |
| `maxTotal` | 后台任务总数上限。 |
| `maxJoinable` | 可汇合任务上限（后台 `Agent` 批次）。 |
| `maxDetached` | 分离任务上限（后台 `bash`）。 |
| `bufferBytes` | 每个分离任务的输出环形缓冲大小（默认 1 MB，丢弃最旧）。 |
| `maxTaskMs` | 后台任务的最长存活时间（墙钟）。 |

## 内置工具

| 工具 | 说明 |
| --- | --- |
| `BashOutput` | 按 `bg_…` id 读取后台 `bash` 命令的增量输出。 |
| `KillBackground` | 按 id 取消运行中的后台任务。 |

两者仅在 `background` 开启时注册，也可以像其他工具一样用 `allowedTools` / `disallowedTools` 过滤。

## 另请参阅

- [子代理](/zh/sdk/tools/subagents) — `Agent` 工具与后台派发。
- [可观测性](/zh/sdk/control/observability) — 消费 `background_completed` 事件。
- [检查点](/zh/sdk/control/checkpointing) — 后台完成事件会进入会话事件日志。
