# @lite-agent/checkpoint-sqlite

[English](./README.md) | **简体中文**

面向 `@lite-agent/core` 的 SQLite（WAL）[`Checkpointer`](../core) 后端 —— 为单机、多进程场景提供事件溯源的会话持久化。当一台机器上的多个进程需要共享会话、`@lite-agent/sdk` 默认的基于文件的存储不够用时，请选择本包。

## 安装

```bash
pnpm add @lite-agent/checkpoint-sqlite
```

> 依赖 `better-sqlite3`（原生模块 —— 安装时会编译）。运行时需要 `@lite-agent/core`。

## 快速开始

把 checkpointer 传给 `createLiteAgent` / `query`，它会覆盖默认的文件存储：

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

## 特性

- **即插即用的 `Checkpointer`** —— 完整契约：`append`、`read`、`head`、`list`、`delete`、`truncate`。
- **多进程安全** —— WAL 日志模式 + `BEGIN IMMEDIATE` 写入路径，支持单机上多进程并发追加。
- **冲突干净抛出** —— 冲突的追加抛出 `CheckpointConflictError`，而不会损坏日志。
- **支持时间旅行** —— `truncate` 支撑会话恢复 / 回退（restore）。
- **持久性可调** —— `synchronous`、`busyTimeoutMs`，以及可选的启动时完整性检查。
- **经过验证** —— 通过 core 的 `checkpointerConformance` 测试套件。

## API

| 符号 | 说明 |
| --- | --- |
| `sqliteCheckpointer(opts)` | 创建 `SqliteCheckpointer`。选项：`file`（路径或 `":memory:"`）、`synchronous`（`"normal"` \| `"full"`）、`busyTimeoutMs`（默认 5000）、`integrityCheckOnOpen`（启动时执行 `PRAGMA quick_check`）。 |
| `SqliteCheckpointer` | core 的 `Checkpointer`，另加 `checkIntegrity(): { ok, detail }` 与 `close()`。 |
| `SqliteCheckpointerOptions` | `sqliteCheckpointer` 接受的选项类型。 |

## 相关

- [`@lite-agent/core`](../core) —— 内核与 `Checkpointer` 接口。
- [`@lite-agent/sdk`](../sdk) —— `createLiteAgent` / `query`；默认的基于文件的 checkpointer。
- [lite-agent monorepo](../..) —— 架构与设计文档。
