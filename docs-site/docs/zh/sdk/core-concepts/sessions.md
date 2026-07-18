# 会话

会话是一段持久、可恢复的对话。使用 `createLiteAgent` 时，每次运行都通过 `Checkpointer` 以**事件溯源方式落盘**，agent 持有一个*当前会话*：连续的 `send()` 调用共享完整对话，你可以跨重启列出并恢复历史会话，还可以把会话回滚到任意历史 prompt。无需编写任何存储代码，就能得到持久的多轮 agent。

无需开启——持久化默认通过内置的 `fileCheckpointer` 启用：

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

## 管理会话

`LiteAgent` 暴露完整的会话生命周期：

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

时间回溯之所以可行，是因为文件工具在修改前都会快照文件：`restore` 回放这些快照以撤销磁盘上的改动，然后截断事件日志。完整的回溯模型见[检查点](/zh/sdk/control/checkpointing)。

设 `sessions: false` 可完全关闭持久化（此时会话方法会 reject）。

## 持久化到外部存储

默认的 `fileCheckpointer` 是单进程的。当同一台机器上的多个进程需要共享会话——HTTP 服务器、worker 池、并行 CLI 运行——换成 `@lite-agent/checkpoint-sqlite` 的 SQLite 后端：

```bash
pnpm add @lite-agent/checkpoint-sqlite
```

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { sqliteCheckpointer } from "@lite-agent/checkpoint-sqlite";

const checkpointer = sqliteCheckpointer({ file: "./sessions.db" }); // or ":memory:"

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  checkpointer,
});

await agent.send("Hello!");
// Sessions persist to sessions.db, shared across processes on this host.

checkpointer.close(); // when you're done
```

SQLite 后端提供基于 WAL 的并发读取、原子 seq 分配和**乐观并发控制**：过期的写入者会收到干净的 `CheckpointConflictError`，而不是静默踩坏日志。任何实现了内核 `Checkpointer` 接口（`append` / `read` / `head` / `list` / `delete` / `truncate`）的自定义后端都以同样方式工作——通过 `checkpointer`（或 `store`）选项传入，它会覆盖 `sessions` 默认项。

:::info
多**机**并发（网络文件系统、分布式写入者）超出 SQLite 的适用范围。`Checkpointer` 接口与后端无关，未来的网络后端可以在不改动内核的情况下覆盖这一场景。
:::

## 另请参阅

- [检查点](/zh/sdk/control/checkpointing) —— `listCheckpoints` / `restore` 时间回溯模型的详细介绍。
- [事件](/zh/sdk/core-concepts/events) —— 每个会话被持久化的 `SessionEvent` 流。
- [代理循环](/zh/sdk/core-concepts/agent-loop) —— 会话中每一轮内部发生了什么。
