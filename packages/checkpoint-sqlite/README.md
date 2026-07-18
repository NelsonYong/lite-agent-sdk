# @lite-agent/checkpoint-sqlite

**English** | [简体中文](./README.zh-CN.md)

SQLite (WAL) [`Checkpointer`](../core) backend for `@lite-agent/core` — event-sourced session persistence for single-host, multi-process setups. Use it when several processes on one machine must share sessions, where the default file-based store in `@lite-agent/sdk` is not enough.

## Install

```bash
pnpm add @lite-agent/checkpoint-sqlite
```

> Depends on `better-sqlite3` (native module — compiles on install). `@lite-agent/core` is required at runtime.

## Quick start

Pass the checkpointer to `createLiteAgent` / `query`; it overrides the default file store:

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

## Features

- **Drop-in `Checkpointer`** — full contract: `append`, `read`, `head`, `list`, `delete`, `truncate`.
- **Multi-process safe** — WAL journaling + `BEGIN IMMEDIATE` writes; concurrent appends from multiple processes on one host.
- **Clean conflicts** — a conflicting append throws `CheckpointConflictError` instead of corrupting the log.
- **Time-travel ready** — `truncate` supports session restore / rewinds.
- **Durability knobs** — `synchronous`, `busyTimeoutMs`, and optional integrity check on open.
- **Verified** — passes core's `checkpointerConformance` test suite.

## API

| Symbol | Description |
| --- | --- |
| `sqliteCheckpointer(opts)` | Create a `SqliteCheckpointer`. Options: `file` (path or `":memory:"`), `synchronous` (`"normal"` \| `"full"`), `busyTimeoutMs` (default 5000), `integrityCheckOnOpen` (run `PRAGMA quick_check` at startup). |
| `SqliteCheckpointer` | A core `Checkpointer` plus `checkIntegrity(): { ok, detail }` and `close()`. |
| `SqliteCheckpointerOptions` | Options accepted by `sqliteCheckpointer`. |

## Related

- [`@lite-agent/core`](../core) — kernel and the `Checkpointer` interface.
- [`@lite-agent/sdk`](../sdk) — `createLiteAgent` / `query`; default file-based checkpointer.
- [lite-agent monorepo](../..) — architecture and design docs.
