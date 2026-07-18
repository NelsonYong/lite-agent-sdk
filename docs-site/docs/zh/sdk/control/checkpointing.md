# 检查点

每次运行都是**事件溯源**的：会话以 `SessionEvent` 的只追加日志形式，通过 `Checkpointer` 契约持久化。这带来两个收益：会话可持久（重启后恢复），以及**时间回溯**——把会话回滚到任意早期检查点，同时撤销对话内容和 agent 做过的文件改动。持久化默认开启（`fileCheckpointer`）；当多个进程需要共享会话时，换成 SQLite 后端。

## 用法

使用默认文件后端时无需任何配置——`createLiteAgent` 会持久化每个会话，并由 `LiteAgent` 持有当前会话：

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

`LiteAgent` 上的会话管理方法：

| 方法 | 说明 |
| --- | --- |
| `send(input, opts?)` | 在当前会话中跑完一轮；返回 `LiteAgentResult`。 |
| `sessionId` | 未传 `opts.sessionId` 时 `run`/`send` 使用的会话 id。 |
| `resume(id)` | 把当前会话切换到已有 id（未知 id 则从空会话开始）。 |
| `clear()` | 轮换到一个新的空会话；返回新 id。旧 transcript 保留。 |
| `listSessions()` | 列出已持久化的会话（`{ id, mtime }`，最近在前）。 |
| `deleteSession(id)` | 删除一个已持久化的会话 transcript。 |
| `compact(instructions?)` | 手动压缩当前会话；返回 `{ before, after }` token 数。 |

设 `sessions: false` 可完全关闭持久化（会话方法将拒绝调用）。

## 时间回溯

检查点就是回滚锚点——每个用户 prompt 一个。`restore(id, seq)` 把会话回滚到某个检查点之前：**还原快照文件**和/或**截断对话**，然后把当前会话设为 `id`。

```ts
const sessions = await agent.listSessions();
agent.resume(sessions[0].id);            // continue the most recent session

const checkpoints = await agent.listCheckpoints(agent.sessionId);
await agent.restore(agent.sessionId, checkpoints[2].seq); // undo everything after that prompt
```

| 方法 | 说明 |
| --- | --- |
| `listCheckpoints(id)` | 列出一个会话的回滚锚点（每个用户 prompt 一个），最旧在前。 |
| `restore(id, seq, opts?)` | 回滚到检查点之前。`opts.files`（默认 `true`）还原快照文件；`opts.conversation`（默认 `true`）截断对话。 |

时间回溯之所以可行，是因为文件工具在修改前会为每个文件做快照：`restore` 重放这些快照撤销磁盘改动，然后截断事件日志。

## 切换 SQLite 后端

默认的 `fileCheckpointer` 是单进程的。`@lite-agent/checkpoint-sqlite` 包提供 `sqliteCheckpointer`——一个 SQLite（WAL）后端，面向**单机多进程**场景：server 或 worker 池中多个进程恢复并追加同一批会话，用乐观并发取代静默覆盖。

| 后端 | 包 | 并发 | 适用场景 |
| --- | --- | --- | --- |
| `fileCheckpointer`（默认） | `@lite-agent/sdk` | 单进程 | 本地开发、CLI 工具、每项目一个 agent 进程 |
| `sqliteCheckpointer` | `@lite-agent/checkpoint-sqlite` | 单机多进程 | 同一台机器上共享会话的 server 或 worker 池 |

```bash
pnpm add @lite-agent/checkpoint-sqlite
```

:::info
依赖 `better-sqlite3`——安装时需要编译的原生模块。运行时需要 `@lite-agent/core`。
:::

把 checkpointer 传给 `createLiteAgent`（或 `query`），它会覆盖默认文件存储：

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

### 选项

`SqliteCheckpointerOptions`：

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `file` | `string` | —（必填） | SQLite 数据库文件路径。用 `":memory:"` 得到临时库（进程级，不共享）。 |
| `synchronous` | `"normal" \| "full"` | `"normal"` | SQLite 持久化级别。WAL 下 `"normal"` 是安全的；`"full"` 可抗 OS 级崩溃，代价是写入延迟。 |
| `busyTimeoutMs` | `number` | `5000` | 竞争写者等待写锁的时长，超时后报错。下限为 `>= 0`。 |
| `integrityCheckOnOpen` | `boolean` | `false` | 启动时运行 `PRAGMA quick_check`；数据库损坏则抛错。 |

### 并发模型

- **WAL 日志** —— 打开时设置 `journal_mode = WAL`：并发读者从不阻塞，同一时刻只有一个写者。
- **`BEGIN IMMEDIATE` 写入** —— `append` 和 `truncate` 先拿写锁，竞争写者会在 `busy_timeout` 内等待而不是报 `SQLITE_BUSY_SNAPSHOT`，然后读到新的 head 并干净地冲突。
- **原子 seq 分配** —— 每次 `append` 是一个事务：读会话 head，插入 `seq = head + 1…n`；数据库串行化并发 append，seq 绝不交错。
- **读不加锁** —— `read({ sinceSeq })` 是纯前向扫描；它也是 server 层用 SSE 推送事件的底层原语。

### 冲突处理

当两个进程持有同一会话时，第二个写者的 `append` 会以 `CheckpointConflictError` 快速失败——乐观并发，冲突永远被抛出、不被吞掉：

```ts
import { CheckpointConflictError } from "@lite-agent/core";

try {
  await checkpointer.append(sessionId, events, knownHead);
} catch (err) {
  if (err instanceof CheckpointConflictError) {
    // err.sessionId, err.expected, err.actual
    // Another client advanced the log: reload (re-read + fold) and retry.
  }
}
```

:::warning
多**机**并发（网络文件系统、分布式写者）超出 SQLite 的能力范围。`Checkpointer` 接口与后端无关，未来的 Postgres 后端可以在不动内核的情况下覆盖该场景。
:::

### Checkpointer 契约

`SqliteCheckpointer` 实现了完整的 core `Checkpointer` 接口，并通过 core 的 `checkpointerConformance` 测试套件——与默认 `fileCheckpointer` 跑的是同一套：

| 方法 | 行为 |
| --- | --- |
| `append(sessionId, events, expectedHead?)` | 单个 immediate 事务。若给定 `expectedHead` 且与当前 head 不同，抛 `CheckpointConflictError`。返回新 head seq。 |
| `read(sessionId, { sinceSeq? })` | 按 seq 顺序重放 `StoredEvent`，可选从 `sinceSeq` 之后（不含）开始。 |
| `head(sessionId)` | 当前 head seq；会话为空或未知时为 `0`。 |
| `list()` | 所有会话，形如 `{ id, mtime }`，最近活跃在前。 |
| `delete(sessionId)` | 删除该会话的事件及其 sessions 表行。 |
| `truncate(sessionId, toSeq)` | 删除所有 `seq > toSeq` 的事件并回退 head。时间回溯由它支撑：`LiteAgent.restore(id, toSeq, { conversation: true })` 把日志截回检查点，作为单个 immediate 事务执行，不会与并发 append 交错。 |

运维接口：`checkIntegrity(): { ok, detail }` 按需运行 `PRAGMA quick_check`；`close()` 关闭数据库句柄（退出前调用——关闭后的 checkpointer 不可复用）。数据库带有 `user_version` schema 标记：打开由更新、不兼容版本写入的文件会立即抛错，而不是误读数据。

## 另请参阅

- [可观测性](/zh/sdk/control/observability) — 把同一事件流记录下来用于审计与调试。
- [后台任务](/zh/sdk/control/background) — `background_completed` 事件会进入同一份会话日志。
- [Core 策略](/zh/core/strategies) — `Checkpointer` 策略接口。
