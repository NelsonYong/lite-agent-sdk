# 子代理

`Agent` 工具把大型或上下文密集的子任务委派给运行在**隔离会话**中的子代理：每个子代理只能看到你传给它的 `prompt`（永远看不到父会话），并且只返回最终文本。隔离保证了父会话上下文的干净——你拿到答案，却不必为产生答案的探索过程付出上下文。

## 声明子代理

一个子代理就是一个带 YAML frontmatter 的 `agents/*.md` 文件；正文即子代理的系统提示：

```markdown
---
name: researcher
description: Research a topic and report findings with sources
tools: [read_file, bash]   # optional allow-list; absent = inherit the parent's tools
model: claude-haiku-4-5    # optional modelName override (same provider)
---

You are a research agent. Always cite your sources ...
```

**加载顺序**（同名时后加载的目录覆盖先加载的）：

1. 全局：`~/.lite-agent/agents`
2. 项目：`<workdir>/.lite-agent/agents`
3. 配置项 `agentsDir`（如设置）

内置的 `general-purpose` 代理（继承父代理的全部工具与模型）总是可用，因此零配置文件也能用子代理。设 `agents: false` 可整体关闭该能力。

## 派发

一次 `Agent` 调用接收一个 `tasks` 数组；同一次调用中的多个条目并行运行（有并发上限），每个结果块都标注 `agentId`，之后可把它作为 `resume` 传回以继续该子代理：

```json
{
  "tasks": [
    { "subagent_type": "researcher", "prompt": "Compare Rspress and VitePress" },
    { "subagent_type": "general-purpose", "prompt": "Audit deps for vulnerabilities" }
  ]
}
```

默认情况下调用会**阻塞**到所有子代理完成；`run_in_background: true` 则为即发即弃，聚合结果稍后以 `<background-task-completed>` 通知形式送达。

:::warning
子代理默认**不继承父代理的权限闸门和 `onApproval` 处理器**——交互式审批无法服务并行的子代理。sandbox 仍然包裹每条命令。如需对子代理启用闸门，传入 `subagentPermission`（用 allow/deny 规则，不要用 `ask`）。
:::

## 编程式访问

如需在 `createLiteAgent` 之外使用同一套加载机制，可直接使用 `AgentLoader` / `builtinAgents`。

## 另请参阅

- [内置工具](/zh/sdk/tools/builtin-tools)——`Agent` 工具说明及如何禁用（`agents: false`）。
- [Skills](/zh/sdk/tools/skills)——另一个由 Markdown 驱动、按需加载的能力。
- [权限](/zh/sdk/control/permissions)——编写 `subagentPermission` 所需的 allow/deny 规则。
- [自定义工具](/zh/sdk/tools/custom-tools)——添加可被子代理继承的工具。
