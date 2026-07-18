# @lite-agent/checkpoint-sqlite

`@lite-agent/core` 的 SQLite（WAL）`Checkpointer` 后端 —— 面向**单机多进程**部署的事件溯源会话持久化。当一台机器上的多个进程需要共享会话、`@lite-agent/sdk` 默认的基于文件的存储不够用时，选它。

## 何时选择它

lite-agent 通过 `Checkpointer` 契约把每个会话持久化为一条只追加的 `SessionEvent` 日志。目前提供两个后端：

| 后端 | 包 | 并发能力 | 适用场景 |
| --- | --- | --- | --- |
| `fileCheckpointer`（默认） | `@lite-agent/sdk` | 单进程 | 本地开发、CLI 工具、每个项目一个 agent 进程 |
| `sqliteCheckpointer` | `@lite-agent/checkpoint-sqlite` | 单机多进程 | 服务器或 worker 池：多个进程恢复/追加同一批会话 |

出现以下情况时选择本包：

- 同一台主机上有多个进程（HTTP 服务、任务 worker、并行 CLI）共享会话。
- 需要**乐观并发控制**：过期的写入者会收到干净的 `CheckpointConflictError`，而不是静默覆盖日志。
- 希望用单个可查询的数据库文件，而不是一目录的 JSONL 记录。

:::warning
多**机**并发（网络文件系统、分布式写入）不在 SQLite 的能力范围内。`Checkpointer` 接口与后端无关，未来可以用 `@lite-agent/checkpoint-postgres` 覆盖该场景，内核无需改动。
:::

## 安装

```bash
pnpm add @lite-agent/checkpoint-sqlite
```

:::info
依赖 `better-sqlite3` —— 原生模块，安装时会编译。运行时需要 `@lite-agent/core`。
:::

## 快速上手

把 checkpointer 传给 `createLiteAgent`（或 `query`），它会覆盖默认的文件存储：

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

## 并发模型

- **WAL 日志** —— 打开时设置 `journal_mode = WAL`：并发读者互不阻塞，同一时刻只有一个写者。
- **`BEGIN IMMEDIATE` 写入** —— `append` 和 `truncate` 在事务开始时就获取写锁，因此竞争写者会在 `busy_timeout` 内等待，而不是以 `SQLITE_BUSY_SNAPSHOT` 失败；随后读取最新的 head 并干净地报冲突。
- **原子分配 seq** —— 每次 `append` 是一个事务：读取会话 head，插入 `seq = head + 1…n`；数据库串行化并发追加，seq 不会交错。
- **读取不加锁** —— `read({ sinceSeq })` 是纯前向扫描；它也是服务端用 SSE 尾随事件流的原语。

## Checkpointer 契约

`SqliteCheckpointer` 完整实现了 core 的 `Checkpointer` 接口：

| 方法 | 行为 |
| --- | --- |
| `append(sessionId, events, expectedHead?)` | 单个 immediate 事务。若传入 `expectedHead` 且与当前 head 不一致，抛出 `CheckpointConflictError`。返回新的 head seq。 |
| `read(sessionId, { sinceSeq? })` | 按 seq 顺序回放 `StoredEvent`，可选从 `sinceSeq` 之后开始（不含）。 |
| `head(sessionId)` | 当前 head seq；会话为空或不存在时为 `0`。 |
| `list()` | 所有会话，形如 `{ id, mtime }`，按最近活跃排序。 |
| `delete(sessionId)` | 删除该会话的全部事件及 sessions 表记录。 |
| `truncate(sessionId, toSeq)` | 删除所有 `seq > toSeq` 的事件并回退 head。是[时间回溯](#时间回溯)的基础。 |

该后端通过了 core 的 `checkpointerConformance` 一致性测试套件 —— 与默认 `fileCheckpointer` 跑的是同一套。

## 配置项

```ts
export interface SqliteCheckpointerOptions {
  file: string;
  synchronous?: "normal" | "full";
  busyTimeoutMs?: number;
  integrityCheckOnOpen?: boolean;
}
```

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `file` | `string` | —（必填） | SQLite 数据库文件路径。用 `":memory:"` 表示临时内存库（仅限本进程，不共享任何数据）。 |
| `synchronous` | `"normal" \| "full"` | `"normal"` | SQLite 持久化级别。WAL 下 `"normal"` 是安全的；`"full"` 可抵御操作系统级崩溃，代价是写入延迟。 |
| `busyTimeoutMs` | `number` | `5000` | 竞争写者等待写锁的最长时间，超时后报错。最小值钳制为 `0`。 |
| `integrityCheckOnOpen` | `boolean` | `false` | 启动时执行 `PRAGMA quick_check`；数据库损坏则抛错。 |

:::tip
数据库带有 `user_version` schema 版本标记。打开由更新版本（不兼容）的本包写入的文件时会立即抛错，而不是误读数据。
:::

## 冲突处理

当两个进程持有同一会话时，第二个写入者的 `append` 会快速失败：

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

这就是乐观并发：冲突被显式抛出、绝不吞掉，两个客户端不可能静默地交错写入同一会话。由调用方决定重新加载 —— 或者结合会话时间回溯，从更早的点分叉。

## 时间回溯

`truncate` 让会话恢复在此后端上成为可能：`LiteAgent.restore(id, toSeq, { conversation: true })` 会把日志截断回某个检查点。它同样以单个 immediate 事务执行，回退操作不会与并发追加交错。

## 运维方法

```ts
const ok = checkpointer.checkIntegrity();
if (!ok.ok) console.error("database corrupt:", ok.detail);

checkpointer.close();
```

- `checkIntegrity(): { ok: boolean; detail: string }` —— 按需执行 `PRAGMA quick_check`（与 `integrityCheckOnOpen` 相同）。
- `close(): void` —— 关闭数据库句柄。进程退出前调用；已关闭的 checkpointer 不能复用。

## 相关

- [`@lite-agent/core`](/zh/packages/core) —— 内核与 `Checkpointer` 接口。
- [`@lite-agent/sdk`](/zh/packages/sdk) —— `createLiteAgent` / `query`；默认的文件型 checkpointer。
- [快速开始](/zh/guide/getting-started) —— 安装与第一个 agent。
