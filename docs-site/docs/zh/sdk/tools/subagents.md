# 子代理

`Agent` 工具把大型或上下文密集的子任务委派给运行在**隔离会话**中的子代理：每个子代理只能看到你传给它的 `prompt`（永远看不到父会话），并且只返回最终文本。隔离保证了父会话上下文的干净——你拿到答案，却不必为产生答案的探索过程付出上下文。

## 声明子代理

一个子代理就是一个带 YAML frontmatter 的 `agents/*.md` 文件；正文即子代理的系统提示：

```markdown
---
name: researcher
description: Research a topic and report findings with sources
tools: [read_file, bash]   # optional allow-list; absent = inherit the parent's tools
model: simple              # 可选：配置的档位或 raw model id 覆盖
---

You are a research agent. Always cite your sources ...
```

**加载顺序**（同名时后加载的目录覆盖先加载的）：

1. 全局：`~/.lite-agent/agents`
2. 项目：`<workdir>/.lite-agent/agents`
3. 配置项 `agentsDir`（如设置）

内置的 `general-purpose` 代理（继承父代理的全部工具与模型）总是可用，因此零配置文件也能用子代理。设 `agents: false` 可整体关闭该能力。

## 模型选择

配置了 `models` catalog 后，可以在 definition 或单个任务中选择 `simple`、`medium`、`complex`。选择顺序固定为：

```text
task.model -> 子代理 definition 的 model -> 当前/默认档位
```

例如，definition 中的 `simple` 会被此任务中的 `complex` 覆盖：

```json
{
  "tasks": [{
    "display_name": "架构审查",
    "subagent_type": "researcher",
    "model": "complex",
    "prompt": "比较两个跨包设计"
  }]
}
```

除已配置档位名外的任意模型字符串都会为兼容性保留为 raw provider model id，并使用继承的 provider。`simple` 适合已知、低歧义的工作（查询或单个小文件流程）；`medium` 适合单个包内的普通多文件工作、修复 bug 和测试；`complex` 适合跨包架构、并发/持久化、外部调研、重复失败或高度不确定的工作。

档位只选择 provider/model 对，不改变权限、审批、推理强度、预算或并发。SDK 尚不会自动分类任务、失败后自动升级，或重试其他档位；父 agent 需要显式选择档位。

## 派发

每次 `Agent` 调用都会创建一个同级**组**。每个任务必须提供非空、可见的
`display_name`：它是本次调用在 UI 和结果中的名称。`subagent_type` 只用于选择
`AgentLoader` definition；返回的 `agentId` 则是稳定的运行身份，之后可作为
`resume` 继续该子代理。

长期 `createLiteAgent()` 会话中的组一律 detached。工具会立即返回“已接受组”的
占位结果；仅在**所有** child settle 后，会话才收到一次、按输入顺序排列的聚合
completion。旧的 `run_in_background` 字段仍可解析，但不再改变语义；即使传入
`run_in_background: false` 也不会使组同步。只有在希望 Agent 派发明确失败、而非
创建后台任务时，才设置 `background: false`。

根 agent 持有一个共享 FIFO pool。`maxParallelSubagents` 默认是 5，且由同一根
实例的所有 session/group 共用，因此两个各含三个任务的组不会各自获得五个 child
槽位。结果保持任务输入顺序：全成功才是 `completed`；混合结果为 `partial`；全部
失败或取消分别为 `failed`、`cancelled`。child 抛异常、被取消、达到 `max_turns`，
或停止却没有最终文本时，绝不会伪装成成功。

例如，可以用两次调用提交两个各含三个任务的组：

```json
{
  "tasks": [
    { "display_name": "架构调研", "subagent_type": "researcher", "prompt": "比较 Rspress 和 VitePress" },
    { "display_name": "依赖审计", "subagent_type": "general-purpose", "prompt": "审计依赖中的漏洞" },
    { "display_name": "测试计划", "subagent_type": "general-purpose", "prompt": "起草回归测试" }
  ]
}
```

```json
{
  "tasks": [
    { "display_name": "API 审查", "subagent_type": "reviewer", "prompt": "审查公开 API" },
    { "display_name": "文档审查", "subagent_type": "writer", "prompt": "找出迁移缺口" },
    { "display_name": "安全审查", "subagent_type": "general-purpose", "prompt": "审查安全假设" }
  ]
}
```

某个组混合完成时，只会在组 settle 后送达一次：

```xml
<background-task-completed id="bg_…" label="Subagent group: 架构调研, 依赖审计, 测试计划" status="partial">
## 架构调研 (agentId: agent-researcher-…; status: completed)
…最终文本…

## 依赖审计 (agentId: agent-general-purpose-…; status: failed)
Error: Subagent reached max turns
</background-task-completed>
```

长期交互请用 `createLiteAgent()` 配合 `subscribe()` / `close()`：同一 session 的用户
轮次和自主 completion 轮次会串行，订阅可收到 child 与聚合事件。`query()` 是一次性
API：关闭临时 agent 前会等待自己发起的 Agent groups 及其自主 completion，不会等待
不相关的 detached daemon（例如后台 Bash）。

child 使用 `agents: false`；不支持递归子代理、Agent Teams、消息总线、共享收件箱
或任务认领。

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
