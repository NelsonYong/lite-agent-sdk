# @lite-agent/sdk

构建在 [`@lite-agent/core`](/zh/packages/core) 之上的开箱即用 agent SDK：一套可用的内置工具、skills、子代理、会话与权限闸门，对外是一个对齐 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) 的小巧 API（`query` / `createLiteAgent` / `tool`）。搭配 [`@lite-agent/provider`](/zh/packages/provider) 提供模型——每一项"内置电池"都只是核心策略之上的可开关默认值。

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

## `query` 与 `createLiteAgent`

- **`query(opts)`** —— 一次性运行。流式产出类型化的 `AgentEvent`，最终 resolve 为 `LiteAgentResult`。适合单轮提问和脚本。
- **`createLiteAgent(cfg)`** —— 有状态、持有会话的 `LiteAgent`，用于多轮工作：`send()`、`resume(id)`、`clear()`、`listSessions()`、`deleteSession(id)`，通过 `listCheckpoints(id)` / `restore(id, seq)` 做时间回溯，以及手动 `compact()`。

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
});

await agent.send("Refactor src/auth.ts to use async/await.");
const result = await agent.send("Now add tests for it."); // same session, full context
```

## 内置工具

所有内置工具默认注册，可用 `allowedTools` / `disallowedTools` 过滤。

| 工具 | 说明 |
| --- | --- |
| `bash` | 在工作区中执行 shell 命令（构建、测试、git、搜索）。`run_in_background: true` 可将长耗时命令转入后台。 |
| `read_file` | 读取文件内容，可用 `limit` 限制大文件的返回行数。 |
| `write_file` | 原子地创建或覆盖文件；自动创建父目录。 |
| `edit_file` | 将文件中第一处精确匹配的 `old_text` 替换为 `new_text`。 |
| `delete_file` | 删除文件（先快照，因此 `restore()` 可以恢复它）。 |
| `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` | 面向多步工作的持久化任务清单（见[任务](#任务)）。 |
| `Agent` | 把子任务委派给子代理（见[子代理](#子代理)）。 |
| `load_skill` | 按需把某个 skill 的正文加载进上下文（见 [Skills](#skills)）。 |
| `BashOutput` | 按 `bg_…` id 读取后台 `bash` 命令的增量输出。 |
| `KillBackground` | 按 id 取消一个正在运行的后台任务。 |
| `ask_user` | 运行中途向用户提问——仅在设置了 `onAskUser` 时注册。 |
| `final_answer` | 返回校验过的结构化答案——仅在设置了 `outputSchema` 时注册。 |

文件工具的作用域限定在 `workdir` 内，写入是原子的，并且每次改动前都会先快照文件，以便会话恢复时可以撤销。

## Skills

一个 skill 就是一个包含 `SKILL.md` 文件的目录——模型按需加载这些指令，而不是让它们在每个 prompt 里白白占用上下文。

**加载顺序**（同名时后加载的目录覆盖先加载的）：

1. 全局：`~/.lite-agent/skills`
2. 项目：`<workdir>/.lite-agent/skills`
3. 配置项 `skillsDir`（如设置）

系统提示中会列出每个 skill 的名称和描述；模型判断某个 skill 相关时，用 `load_skill` 工具拉取完整正文。

**`SKILL.md` 格式**——YAML frontmatter + Markdown 正文：

```markdown
---
name: pdf-tools          # optional; defaults to the directory name
description: Extract and merge PDF files  # surfaced in the system prompt
tags: [docs, pdf]        # optional, string or list
---

When the user asks to merge PDFs, run ...
```

如需在 `createLiteAgent` 之外使用同一套机制，可直接使用 `SkillLoader` / `loadSkillTool`。

## 子代理

`Agent` 工具把大型或上下文密集的子任务委派给运行在**隔离会话**中的子代理：每个子代理只能看到你传给它的 `prompt`（永远看不到父会话），并且只返回最终文本。隔离保证了父会话上下文的干净。

**声明子代理**——一个带 YAML frontmatter 的 `agents/*.md` 文件；正文即子代理的系统提示：

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

**派发**——一次 `Agent` 调用接收一个 `tasks` 数组；同一次调用中的多个条目并行运行（有并发上限），每个结果块都标注 `agentId`，之后可把它作为 `resume` 传回以继续该子代理：

```json
{
  "tasks": [
    { "subagent_type": "researcher", "prompt": "Compare Rspress and VitePress" },
    { "subagent_type": "general-purpose", "prompt": "Audit deps for vulnerabilities" }
  ]
}
```

默认情况下调用会**阻塞**到所有子代理完成；`run_in_background: true` 则为即发即弃，聚合结果稍后以通知形式送达。

:::warning
子代理默认**不继承父代理的权限闸门和 `onApproval` 处理器**——交互式审批无法服务并行的子代理。sandbox 仍然包裹每条命令。如需对子代理启用闸门，传入 `subagentPermission`（用 allow/deny 规则，不要用 `ask`）。
:::

## 任务

持久化任务清单对齐 Claude Code 的 Tasks API：`TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`。每个任务是 `~/.lite-agent/projects/<hash>/tasks/<listId>/` 下的一个 JSON 文件，因此能跨压缩、跨重启存活，并在同一项目的所有会话间共享（包括子代理）。一个每轮中间件会把当前清单以 `<system-reminder>` 形式注入模型请求，但不写入持久化记录。

- 任务包含 `subject`、`description`、`status`（`pending` / `in_progress` / `completed`），以及自动维护的 `blockedBy` / `blocks` 依赖关系（带循环检测）。
- `taskListId`（或 `$LITE_AGENT_TASK_LIST_ID`）选择清单；`tasks: false` 关闭任务工具和提醒。

## 会话

使用默认的 `fileCheckpointer`（或任意 `Checkpointer`，如 [`@lite-agent/checkpoint-sqlite`](/zh/packages/checkpoint-sqlite)）时，每次运行都以事件溯源方式落盘，`LiteAgent` 持有当前会话：

| 方法 | 说明 |
| --- | --- |
| `send(input, opts?)` | 在当前会话中跑完一轮；resolve 为 `LiteAgentResult`。 |
| `sessionId` | 未传 `opts.sessionId` 时 `run`/`send` 使用的会话 id。 |
| `resume(id)` | 把当前会话切换到一个已有 id（未知 id 则从空会话开始）。 |
| `clear()` | 切换到一个全新的空会话并返回新 id；旧会话记录保留。 |
| `listSessions()` | 列出已持久化的会话（`{ id, mtime }`，最新在前）。 |
| `deleteSession(id)` | 删除一个已持久化的会话记录。 |
| `listCheckpoints(id)` | 列出一个会话的回溯锚点（每个用户 prompt 一个），按时间从旧到新。 |
| `restore(id, seq, opts?)` | 把会话回滚到某个锚点之前：恢复快照过的文件（`files`，默认 `true`）和/或截断对话（`conversation`，默认 `true`）。同时把当前会话设为 `id`。 |
| `compact(instructions?)` | 手动压缩当前会话；流式产出进度事件，resolve 为 `{ before, after }` token 数。 |

```ts
const sessions = await agent.listSessions();
agent.resume(sessions[0].id);            // continue the most recent session

const checkpoints = await agent.listCheckpoints(agent.sessionId);
await agent.restore(agent.sessionId, checkpoints[2].seq); // undo everything after that prompt
```

时间回溯之所以可行，是因为文件工具在修改前都会快照文件：`restore` 回放这些快照以撤销磁盘上的改动，然后截断事件日志。设 `sessions: false` 可完全关闭持久化（此时会话方法会 reject）。

## 权限闸门

`policy()` 把工具调用与 allow/ask/deny 规则集匹配，决定什么可以执行。工具名匹配使用 glob，优先级恒为 **deny > ask > allow**——顺序错误的 allow 永远无法遮蔽 deny：

```ts
import { createLiteAgent, policy, bashCommand, filePath } from "@lite-agent/sdk";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  permission: policy({
    allow: ["read_file", "Task*"],
    ask: ["write_file", "edit_file"],
    deny: ["bash"],
  }),
  onApproval: {
    // human-in-the-loop: decide each "ask" call
    request: async (call) => (confirm(`Allow ${call.name}?`) ? "allow" : "deny"),
  },
  permissionAudit: true, // persist redacted decisions in the session event log
});
```

### 内容级规则

除了工具名，`policy({ rules })` 还能通过 `when` 条件匹配**调用入参**（对 `command`、`path` 这类点路径做 `glob` / `regex` / `startsWith` / `equals` 等匹配）。sdk 为内置工具提供了便捷的 specifier：

```ts
permission: policy({
  rules: [
    bashCommand("rm -rf*", "deny"),        // block destructive shell commands
    bashCommand("git status*", "allow"),   // `:*` desugars to a prefix match
    filePath("src/**", "allow"),           // allow file tools under ./src
    filePath("**/.env*", "deny"),          // …but never touch env files
  ],
  default: "ask",
}),
```

:::tip
bash 命令匹配是尽力而为的——shell 的引号和命令链可以绕过前缀规则。权限闸门是纵深防御的一环；真正的隔离边界是 [sandbox](#sandbox)。
:::

### 审计与试运行

- `permissionAudit: true` 会把脱敏后的 `permission_decision` 事件追加到会话日志中，记录每个决策及其来源（`policy` / `user` / `auto`）。工具入参中的密钥由 `defaultRedactor` 打码（可用 `redact` 覆盖）。
- `permissionMode: "dry-run"` 只计算并记录裁决，**不拦截任何调用**——把候选策略放到真实流量上，先看清它会拒绝什么，再切换到强制模式。
- 策略可用 `composePolicies(...)` 以 deny 优先的方式组合（下游无法放宽托管层的限制），`strictPolicy({ allow })` 则提供默认拒绝的安全姿态。

## Sandbox

传入一个 `Sandbox`（如 [`@lite-agent/sandbox-anthropic`](/zh/packages/sandbox-anthropic)），即可让每条 `bash` 命令在 OS 边界内运行（macOS 用 Seatbelt，Linux 用 bubblewrap）：

```ts
import { sandboxRuntime } from "@lite-agent/sandbox-anthropic";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  sandbox: sandboxRuntime({ allowedDomains: ["api.github.com"] }),
});
```

闸门决定命令**能否**执行；sandbox 约束它执行时**能碰到什么**——两者天然组合。完整适配器说明见 [`@lite-agent/sandbox-anthropic`](/zh/packages/sandbox-anthropic)。

## 结构化输出

设置 `outputSchema`（一个 Zod **对象** schema）可强制模型给出校验过的最终答案。sdk 会注册一个以你的 schema 为参数的 `final_answer` 工具，指示模型在完成时恰好调用一次，校验后的参数通过 `result.output` 返回：

```ts
const result = await agent.send("Summarize package.json");

// with outputSchema: z.object({ name: z.string(), deps: z.number() })
result.output; // { name: "…", deps: 42 } — validated against the schema
```

`outputSchema` 不会被子代理继承。

## 后台任务

`background: true`（默认）时，长耗时工作可以离开前台：

- **`bash` 配 `run_in_background: true`** 以分离模式运行——立即返回一个 `bg_…` id，且不阻塞运行结束。用 `BashOutput` 轮询增量输出；进程会在运行结束时自动停止。
- **`Agent` 配 `run_in_background: true`**（可选；默认阻塞）把整批子代理作为一个可汇合的后台任务派发——运行会保持存活直到其完成，聚合结果以 `<background-task-completed>` 通知形式送达。
- **`KillBackground`** 按 id 取消任意正在运行的后台任务。

每个任务完成时都会发出 `background_completed` 事件。`background: false` 关闭该特性并移除 `BashOutput` / `KillBackground`。

## `createLiteAgent` 配置项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `model` | — | **必填。** 来自 [`@lite-agent/provider`](/zh/packages/provider) 的 `ModelProvider`。 |
| `modelName` | provider 默认 | 转发给 provider 的模型 id。 |
| `workdir` | — | **必填。** 工作区根目录；文件工具的作用域。 |
| `system` | 内置提示 | 覆盖系统提示。 |
| `tools` | — | 额外工具（经 `tool()` 创建），追加在内置工具之后。 |
| `allowedTools` / `disallowedTools` | — | 按名称过滤最终工具集。 |
| `maxTurns` | — | 单次运行的对话轮数上限。 |
| `maxTokens`、`temperature`、`topP`、`toolChoice`、`seed` | — | 转发给 provider 的采样参数。 |
| `maxParallelTools` | `10` | 每轮最大并发工具调用数（`1` = 串行）。 |
| `outputSchema` | — | 用于校验最终答案的 Zod 对象 schema。 |
| `sandbox` | — | 包裹 `bash` 命令的 `Sandbox` 策略。 |
| `permission` / `onApproval` | — | 权限策略 + 人在环审批处理器。 |
| `permissionMode` | `"enforce"` | `"dry-run"` 只记录决策不拦截。 |
| `permissionAudit` | `false` | 在会话日志中持久化脱敏后的权限决策。 |
| `redact` | `defaultRedactor` | 审计载荷的脱敏器。 |
| `onAskUser` | — | 输入处理器；设置后注册 `ask_user` 工具。 |
| `skillsDir` | — | 额外 skills 目录（覆盖全局 + 项目）。 |
| `tasks` / `taskListId` | `true` / `"default"` | 持久化任务工具 + 提醒；使用哪个清单。 |
| `agents` / `agentsDir` | `true` / — | 子代理与 `Agent` 工具；额外 agents 目录。 |
| `subagentPermission` | — | 应用于子代理运行的权限策略。 |
| `background` / `backgroundLimits` | `true` / — | 后台任务（`BashOutput` / `KillBackground`）。 |
| `sessions` | `true` | 持久化会话（设置了 `checkpointer`/`store` 时忽略）。 |
| `checkpointer` / `store` | `fileCheckpointer` | 持久化后端。 |
| `context` | 引擎默认值 | 自动上下文管理（`{ windowTokens, planner }`；`false` 关闭）。 |
| `home` | `$LITE_AGENT_HOME` \|\| `~/.lite-agent` | 全局 home 目录。 |
| `cleanup` | `true`（30 天） | 启动时清理过期的 spill/会话文件。 |
| `crashRecovery` | — | `"safe"` 会记录工具启动并在恢复时关闭被中断的调用。 |
| `use` | — | 额外中间件。 |
| `codec` | `nativeCodec()` | 工具调用协议。 |
| `fileTools` / `bash` | — | 各工具的加固选项。 |

`query(opts)` 接受同样的选项，外加 `prompt`（以及用于恢复指定会话的 `sessionId`）——有两处改名：`workdir` → `cwd`，`system` → `systemPrompt`。

## API 一览

| 符号 | 说明 |
| --- | --- |
| `query(opts)` | 一次性 agent 运行——`AsyncGenerator<AgentEvent, LiteAgentResult>`。 |
| `createLiteAgent(cfg)` | 有状态、持有会话的 agent（`LiteAgent`）。 |
| `tool(name, description, schema, handler)` | 用 Zod schema 定义工具。 |
| `buildSystemPrompt(opts)` | 默认系统提示构建器。 |
| `defaultTools`、`bashTool`、`fileTools`、`taskTools`、`agentTool`、`askUserTool`、`bashOutputTool`、`killBackgroundTool` | 内置工具集，可单独导入。 |
| `policy`、`bashCommand`、`filePath`、`permissionFilePolicy` | 权限策略与内容级 specifier。 |
| `fileCheckpointer`、`jsonlStore`、`fileTaskStore`、`fileSpillStore`、`fileContextArchive` | 文件后端的持久化适配器。 |
| `jsonlEventSink`、`recordEventStream` | 事件可观测性 sink。 |
| `SkillLoader`、`loadSkillTool`、`AgentLoader`、`builtinAgents` | skill 与子代理加载。 |
| `* from @lite-agent/core` | 完整转出口径：类型、事件、策略、中间件辅助函数。 |

## 另请参阅

- [`@lite-agent/core`](/zh/packages/core) —— 本包所组装的 provider 无关内核。
- [`@lite-agent/provider`](/zh/packages/provider) —— 模型 provider（Anthropic 等）。
- [`@lite-agent/checkpoint-sqlite`](/zh/packages/checkpoint-sqlite) —— SQLite 会话持久化。
- [`@lite-agent/sandbox-anthropic`](/zh/packages/sandbox-anthropic) —— OS 级 sandbox 适配器。
- [`@lite-agent/local`](/zh/packages/local) —— 严格的本地加固默认值。
- [快速上手](/zh/guide/getting-started) —— 安装并运行你的第一个 agent。
