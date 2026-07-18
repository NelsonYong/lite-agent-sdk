# @lite-agent/sdk

[English](./README.md) | **简体中文**

构建在 [`@lite-agent/core`](../core) 之上的开箱即用 Agent SDK：一套可用的工具、技能、子 Agent、会话和权限门，隐藏在一套小巧、参照 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) 设计的 API（`query` / `createLiteAgent` / `tool`）之后。搭配一个 [`@lite-agent/provider`](../provider) 提供模型即可 —— 每一项「电池」都只是基于内核策略的可开关默认值。

## 安装

```bash
pnpm add @lite-agent/sdk @lite-agent/provider zod
```

## 快速开始

```ts
import { query, tool } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { z } from "zod";

const weather = tool(
  "get_weather",
  "Get the weather for a city",
  z.object({ city: z.string() }),
  async ({ city }) => `It's sunny in ${city}.`,
);

for await (const ev of query({
  prompt: "What's the weather in Tokyo?",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  tools: [weather],
  allowedTools: ["get_weather", "read_file"],
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

`query()` 流式产出类型化的 `AgentEvent`，最终返回 `LiteAgentResult`。多轮场景用 `createLiteAgent(cfg)`：它返回一个有状态、持有当前会话的 `LiteAgent` —— `send()`、`resume(id)`、`clear()`、`listSessions()`、`deleteSession(id)`，通过 `listCheckpoints(id)` / `restore(id, seq)` 做时间旅行，以及手动 `compact()`。

### 长生命周期后台轮次

交互式客户端可以只订阅一次；即使某次 `run()` 或 `send()` 已经返回，仍能继续接收后续事件：

```ts
const agent = createLiteAgent({ model, workdir: process.cwd() });
const unsubscribe = agent.subscribe(({ sessionId, source, event }) => {
  render(sessionId, source, event); // 也包含自主触发的后台轮次
});

await agent.send("在后台开始长时间代码审查");
await agent.send("与此同时，先回答另一个问题");

// 应用退出时：
unsubscribe();
await agent.close();
```

普通 `Agent` 调用仍默认阻塞。为 `Agent` 或 `bash` 显式设置
`run_in_background: true` 后会立即返回，并在同一个存活进程的 session
中跨后续轮次继续执行；完成时自动唤醒其原始 session。同一个 session
里的用户轮次和 completion 轮次严格串行。进程重启后不会恢复尚未完成的
任务。`query()` 仍是一次性 API，会关闭其临时后台任务；长生命周期交互请使用
`createLiteAgent()` 配合 `subscribe()`。

## 特性

- **默认工具** —— `bash`、`read_file`、`write_file`、`edit_file`、`delete_file`，限定在 `workdir` 内；原子写 + 变更前快照，会话恢复可撤销这些修改。
- **技能（Skills）** —— 从 `~/.lite-agent/skills`、`<workdir>/.lite-agent/skills` 或 `skillsDir` 加载 `SKILL.md`；通过 `load_skill` 按需注入。
- **子 Agent** —— 可并行的 `Agent` 派发工具，内置 `general-purpose` agent；可用 `agents/*.md` 自定义（`agents: false` 关闭）。
- **任务（Tasks）** —— 持久化任务列表（`TaskCreate/Update/Get/List`），带每轮提醒（`tasks: false` 关闭）。
- **会话（Sessions）** —— 通过 `fileCheckpointer` 做事件溯源持久化；可替换为 [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) 或任意 `Checkpointer`。
- **压缩（Compaction）** —— 确定性默认 compactor（不调用 LLM）、反应式溢出兜底，超大 tool_result 落盘 spill。
- **权限门** —— `policy({ allow, ask, deny })`，按工具名 glob 匹配（`deny > ask > allow`）；配合 `onApproval` 实现人机协同，`permissionAudit: true` 持久化脱敏决策。
- **沙箱** —— 传入一个 `Sandbox`（如 [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic)），让 `bash` 在操作系统边界内运行。
- **人工输入** —— 设置 `onAskUser` 后注册 `ask_user` 工具，允许模型在运行中向你提问。
- **结构化输出** —— 设置 `outputSchema`（Zod object）强制返回经校验的最终答案，通过 `result.output` 暴露。
- **后台任务** —— 默认启用（`background: false` 关闭）；后台 Agent/Bash 可跨轮次继续运行，并通过 `bash_output` / `kill_background` 观察和控制。
- **本地加固** —— 可配置 prompt codec/修复、上下文预算、快照限制、崩溃恢复和带 hash chain 的事件日志；严格默认值见 [`@lite-agent/local`](../local)。

## API

| 符号 | 说明 |
| --- | --- |
| `query(opts)` | 一次性 Agent 运行 —— `AsyncGenerator<AgentEvent, LiteAgentResult>`。 |
| `createLiteAgent(cfg)` | 有状态、持有会话的 Agent（`LiteAgent`），包含 `subscribe()` 和 `close()`。 |
| `tool(name, description, schema, handler)` | 用 Zod schema 定义一个工具。 |
| `buildSystemPrompt(opts)` | 默认系统提示词构建器。 |
| `defaultTools`、`bashTool`、`fileTools`、`taskTools`、`agentTool`、`askUserTool`、`bashOutputTool`、`killBackgroundTool` | 内置工具集，可单独导入。 |
| `policy`、`bashCommand`、`filePath`、`permissionFilePolicy` | 权限策略与内容级 specifier。 |
| `fileCheckpointer`、`jsonlStore`、`fileTaskStore`、`fileSpillStore`、`fileContextArchive` | 基于文件的持久化适配器。 |
| `jsonlEventSink`、`recordEventStream` | 事件可观测性 sink。 |
| `SkillLoader`、`loadSkillTool`、`AgentLoader`、`builtinAgents` | 技能与子 Agent 加载。 |
| `* from @lite-agent/core` | 完整重导出内核：类型、事件、策略、中间件辅助函数。 |

## 相关链接

- [`@lite-agent/core`](../core) —— 本包所组装的、与 provider 无关的内核。
- [`@lite-agent/provider`](../provider) —— 模型 provider（Anthropic 等）。
- [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) · [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic) · [`@lite-agent/local`](../local) —— 可插拔后端与加固。
- [Monorepo 根目录](../..) —— 架构总览；[`examples/cli`](../../examples/cli) —— 完整的交互式 REPL（串联 provider + 沙箱 + 权限 + `ask_user`）。
