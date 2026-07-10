# @lite-agent/checkpoint-sqlite

[English](./README.md) | **简体中文**

面向 [`@lite-agent/core`](../core) 的 SQLite（WAL）`Checkpointer` 后端 —— 为单机、多进程场景提供事件溯源的会话持久化。

[`@lite-agent/sdk`](../sdk) 中默认的 checkpointer 是基于文件的（每个会话一个 JSONL）。本适配器改为把同样的事件日志存进 SQLite 数据库，采用 **WAL 日志模式**和 `BEGIN IMMEDIATE` 写入路径，使单机上的多个进程能够并发追加 —— 冲突的追加会干净地抛出 `CheckpointConflictError`，而不会损坏日志。

## 安装

```bash
pnpm add @lite-agent/checkpoint-sqlite
```

> 依赖 `better-sqlite3`（原生模块 —— 安装时会编译）。

## 用法

把 checkpointer 传给 `createLiteAgent` / `query`；它会覆盖默认的文件存储：

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { sqliteCheckpointer } from "@lite-agent/checkpoint-sqlite";

const checkpointer = sqliteCheckpointer({ file: "./sessions.db" }); // 或 ":memory:"

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  checkpointer,
});

await agent.send("你好！");
// 会话持久化到 sessions.db，并在本机各进程间共享。

checkpointer.close(); // 用完后关闭
```

## API

`sqliteCheckpointer({ file })` → `SqliteCheckpointer`（core 的 `Checkpointer` 再加 `checkIntegrity()` / `close()`）：

- `file` —— SQLite 数据库文件路径，或用 `":memory:"` 得到一个临时（内存）数据库。
- `synchronous` —— `"normal"`（默认）或更强持久性的 `"full"`。
- `busyTimeoutMs` —— 写锁等待超时（默认 5000 ms）。
- `integrityCheckOnOpen` —— 启动时执行 `PRAGMA quick_check`，损坏则失败。

它实现了完整的 `Checkpointer` 契约 —— `append`（乐观并发，由 `expectedHead` 守护）、`read`、`head`、`list`、`delete`，以及 `truncate`（因此会话时间旅行 / `restore` 可用）—— 并通过 core 的 `checkpointerConformance` 测试套件验证。

架构说明见 [monorepo 根目录](../..)。
