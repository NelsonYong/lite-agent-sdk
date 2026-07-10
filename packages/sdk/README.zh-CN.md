# @lite-agent/sdk

[English](./README.md) | **简体中文**

构建在 [`@lite-agent/core`](../core) 之上的开箱即用 Agent SDK。它把内核与一套可用的工具集（bash + 文件操作）、技能（skills）、子 Agent、持久化任务列表、构建好的系统提示词、会话、压缩以及可选的权限门（permission gate）组装到一起 —— 通过一套小巧、参照 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) 设计的 API（`query` / `createLiteAgent` / `tool`）暴露出来。

搭配一个 [`@lite-agent/provider`](../provider) 提供模型即可。所有能力都是可选、可替换的 —— 这些「电池」只是基于内核策略的一组合理默认值。

## 安装

```bash
pnpm add @lite-agent/sdk @lite-agent/provider zod
```

## 快速开始 —— `query()`

一次性调用的门面。流式产出类型化的 `AgentEvent`，并返回 `RunResult`。

```ts
import { query } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

for await (const ev of query({
  prompt: "列出当前目录的文件，并总结这个项目是做什么的。",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  cwd: process.cwd(),
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

## `createLiteAgent()` —— 有状态的 Agent

它持有一个「当前会话」，因此 `send` / `run` 默认就是多轮的。用 `tool()` 添加你自己的工具，并用权限 `policy` 为危险工具加门控。

```ts
import { createLiteAgent, tool, policy } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { z } from "zod";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  tools: [
    tool(
      "get_weather",
      "获取某个城市的天气",
      z.object({ city: z.string() }),
      async ({ city }) => `${city} 现在是晴天。`,
    ),
  ],
  // 运行有副作用的内置工具前先询问；其余工具自由运行。
  permission: policy({ ask: ["bash", "write_file", "edit_file", "delete_file"] }),
  permissionAudit: true, // 将脱敏后的权限决策持久化到会话事件日志
  onApproval: { request: async (call) => "allow" }, // 由你的 UI 决定
});

await agent.send("记住我的名字叫 Nelson。");
const result = await agent.send("我叫什么名字？另外东京天气怎么样？");
console.log(result.text); // 同一会话 —— 它记得
```

返回的 `LiteAgent` 上的会话管理：`sessionId`、`resume(id)`、`clear()`、`listSessions()`、`deleteSession(id)`，以及时间旅行 —— `listCheckpoints(id)` / `restore(id, seq)`（回滚文件和/或对话），还有手动 `compact()`。

## 内置能力

由 `createLiteAgent` 组装（每一项都可开关）：

- **默认工具** —— `bash`、`read_file`、`write_file`、`edit_file`、`delete_file`，全部限定在 `workdir` 内。文件修改使用原子写，并记录有大小上限的 UTF-8/base64 变更前快照，可逐字节恢复文本或二进制文件。
- **技能（Skills）** —— 从 `~/.lite-agent/skills`、`<workdir>/.lite-agent/skills` 以及显式的 `skillsDir` 加载 `SKILL.md`（YAML frontmatter）；通过 `load_skill` 按需注入。
- **子 Agent** —— 一个可并行的 `Agent` 派发工具，内置 `general-purpose` agent；你可以用 `agents/*.md` 添加自定义 agent。（`agents: false` 关闭。）
- **任务（Tasks）** —— 一个持久化任务列表（`TaskCreate/Update/Get/List`），并带每轮提醒。（`tasks: false` 关闭。）
- **会话（Sessions）** —— 通过项目目录下的 `fileCheckpointer` 做事件溯源持久化；可替换为 [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) 或任意 `Checkpointer`。
- **压缩（Compaction）** —— 一个确定性的默认 compactor（不调用 LLM）加上一层反应式溢出兜底；对超大 tool_result 做磁盘 **spill**。
- **权限门** —— `policy({ allow, ask, deny })`，按工具名 glob 匹配（`deny > ask > allow`）；配合 `onApproval` 实现人机协同。设置 `permissionAudit: true` 可持久化脱敏后的 `permission_decision` sidecar（默认关闭）。持久化审计需要事件溯源 `Checkpointer`；旧 `Store` 适配器只保留模型消息。
- **沙箱** —— 传入一个 `Sandbox`（如 [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic)）即可让 `bash` 在操作系统边界内运行。
- **`ask_user`** —— 设置了 `onAskUser` 后注册，允许模型在运行中向你提问。
- **结构化输出** —— 设置 `outputSchema`（一个 Zod object）以强制返回经校验的最终答案，通过 `result.output` 暴露。
- **本地加固原语** —— 可配置 prompt codec/修复、上下文预算、文件与快照限制、崩溃恢复、托管权限文件和带 hash chain 的轮转事件日志。严格默认值见 [`@lite-agent/local`](../local)。

## API

- `query(opts)` → `AsyncGenerator<AgentEvent, LiteAgentResult>` —— 一次性调用。
- `createLiteAgent(cfg)` → `LiteAgent` —— 有状态、持有会话的 Agent。
- `tool(name, description, schema, handler)` —— 用 Zod schema 定义一个工具。
- `buildSystemPrompt(opts)` —— 默认系统提示词构建器。
- 重导出 [`@lite-agent/core`](../core) 的全部内容（类型、事件、策略、中间件辅助函数）。

架构说明见 [monorepo 根目录](../..)；完整的交互式 REPL（串联 provider + 沙箱 + 权限 + `ask_user`）见 [`examples/cli`](../../examples/cli)。
