# 内置工具

`@lite-agent/sdk` 开箱自带一套可用工具——shell 访问、限定在工作区内的文件工具、持久化任务清单、子代理派发等——新 agent 零配置即可投入工作。所有内置工具默认注册，可按名称过滤，也可按能力整体关闭。

## 工具一览

| 工具 | 说明 |
| --- | --- |
| `bash` | 在工作区中执行 shell 命令（构建、测试、git、搜索）。`run_in_background: true` 可将长耗时命令转入后台。 |
| `read_file` | 读取文件内容，可用 `limit` 限制大文件的返回行数。 |
| `write_file` | 原子地创建或覆盖文件；自动创建父目录。 |
| `edit_file` | 将文件中第一处精确匹配的 `old_text` 替换为 `new_text`。 |
| `delete_file` | 删除文件（先快照，因此 `restore()` 可以恢复它）。 |
| `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` | 面向多步工作的持久化任务清单。 |
| `Agent` | 把子任务委派给[子代理](/zh/sdk/tools/subagents)。 |
| `load_skill` | 按需把某个 [skill](/zh/sdk/tools/skills) 的正文加载进上下文。 |
| `BashOutput` | 按 `bg_…` id 读取后台 `bash` 命令的增量输出。 |
| `KillBackground` | 按 id 取消一个正在运行的后台任务。 |
| `ask_user` | 运行中途向用户提问——仅在设置了 `onAskUser` 时注册。 |
| `final_answer` | 返回校验过的结构化答案——仅在设置了 `outputSchema` 时注册。 |

文件工具的作用域限定在 `workdir` 内，写入是原子的，并且每次改动前都会先快照文件，以便会话恢复时可以撤销。

## 禁用工具

用 `allowedTools`（白名单）或 `disallowedTools`（黑名单）按名称过滤最终工具集：

```ts
const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  disallowedTools: ["bash", "delete_file"],
});
```

整个能力（连同其工具）可以用一个开关关闭：

| 选项 | 效果 |
| --- | --- |
| `tasks: false` | 移除 `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` 及任务提醒。 |
| `agents: false` | 移除 `Agent` 及整个子代理能力。 |
| `background: false` | 移除 `BashOutput` / `KillBackground` 及后台任务特性。 |

:::tip
过滤是对模型隐藏工具；[权限闸门](/zh/sdk/control/permissions)决定工具实际能否执行。两者配合：过滤用于聚焦，闸门用于安全。
:::

内置工具集也可单独导入——`defaultTools`、`bashTool`、`fileTools`、`taskTools`、`agentTool`、`askUserTool`、`bashOutputTool`、`killBackgroundTool`——便于你在内核之上自行组装 agent。

## 另请参阅

- [自定义工具](/zh/sdk/tools/custom-tools)——用 `tool()` 添加你自己的工具。
- [子代理](/zh/sdk/tools/subagents)——`Agent` 工具委派的目标。
- [Skills](/zh/sdk/tools/skills)——`load_skill` 加载的内容。
- [权限](/zh/sdk/control/permissions)——用 allow / ask / deny 规则门控工具调用。
