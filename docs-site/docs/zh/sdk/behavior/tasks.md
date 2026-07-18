# 任务清单

多步骤工作需要一份模型看得见、改得动的计划——而且它要能扛住上下文压缩和进程重启。任务清单能力为 agent 提供一个**持久化任务列表**，对标 Claude Code 的 Tasks API：四个内置工具（`TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`）、同一项目跨 session 共享的磁盘存储，以及一个逐轮 reminder，让当前列表始终呈现在模型面前而不污染会话记录。

## 用法

任务清单默认开启——无需任何配置。默认[系统提示词](/zh/sdk/behavior/system-prompt)已经教会模型这套工作流：任何 3 步以上的任务先调用 `TaskCreate` 记录每个步骤，开始前置为 `in_progress`，完全做完才标记 `completed`。

要为一次运行指定具名列表，或关闭整个能力：

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  taskListId: "release-0.4", // which list to use; default "default"
  // tasks: false,           // disable the tools and the reminder entirely
});
```

`query()` 接受相同的 `tasks` / `taskListId` 选项。列表也可以通过 `$LITE_AGENT_TASK_LIST_ID` 环境变量选择（优先级：`taskListId` > 环境变量 > `"default"`）。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `TaskCreate` | 创建任务：祈使句 `subject` 加详细 `description`（可选 `activeForm`、`metadata`）。返回新任务 id。 |
| `TaskUpdate` | 设置 `status`（`pending` / `in_progress` / `completed`）、编辑字段、设置 `owner`，或通过 `addBlockedBy` / `addBlocks` 建立依赖。会造成依赖**环的更新被拒绝**。 |
| `TaskGet` | 按 id 获取单个任务的完整详情（description、status、依赖边）。 |
| `TaskList` | 列出所有任务及其 status 和 `blockedBy` 依赖。 |

## 工作原理

- **持久化** —— 每个任务是 `~/.lite-agent/projects/<hash>/tasks/<listId>/` 下的一个 JSON 文件（原子写入，文件锁保护）。列表能扛住压缩和进程重启，并且在**同一项目的多个 session 之间共享——包括 [subagents](/zh/sdk/tools/subagents)**，因此父子 agent 可以在同一份列表上协作。
- **逐轮 reminder** —— 一个中间件在每轮模型请求编码前，把渲染后的列表作为末尾的 `<system-reminder>` 重新注入。reminder 从不追加到会话记录、也不持久化，因此事件日志保持干净，而模型始终看到最新状态。
- **依赖** —— `blockedBy` / `blocks` 边由 `TaskUpdate` 对称维护，DFS 环检测会拒绝任何可能让依赖图死锁的更新。

## 关闭

设置 `tasks: false` 会同时移除全部四个工具**和** reminder 中间件：

```ts
const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  tasks: false,
});
```

## 另请参阅

- [系统提示词](/zh/sdk/behavior/system-prompt) —— 默认提示词中的任务规划指引。
- [Subagents](/zh/sdk/tools/subagents) —— 子 agent 共享项目的任务列表。
- [会话](/zh/sdk/core-concepts/sessions) —— 任务列表所能扛住的持久化与压缩。
- [快速上手](/zh/sdk/getting-started) —— 安装并运行你的第一个 agent。
