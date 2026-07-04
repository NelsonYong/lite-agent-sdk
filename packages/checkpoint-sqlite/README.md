# @lite-agent/checkpoint-sqlite

**English** | [简体中文](./README.zh-CN.md)

A SQLite (WAL) `Checkpointer` backend for [`@lite-agent/core`](../core) — event-sourced session persistence for single-host, multi-process setups.

The default checkpointer in [`@lite-agent/sdk`](../sdk) is file-based (one JSONL per session). This adapter stores the same event log in a SQLite database instead, using **WAL journaling** and a `BEGIN IMMEDIATE` write path so several processes on one host can append concurrently — a conflicting append throws `CheckpointConflictError` cleanly rather than corrupting the log.

## Install

```bash
pnpm add @lite-agent/checkpoint-sqlite
```

> Depends on `better-sqlite3` (a native module — it compiles on install).

## Usage

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
// Sessions persist to sessions.db and are shared across processes on this host.

checkpointer.close(); // when you're done
```

## API

`sqliteCheckpointer({ file })` → `SqliteCheckpointer` (a core `Checkpointer` plus `close()`):

- `file` — path to the SQLite database, or `":memory:"` for an ephemeral DB.

It implements the full `Checkpointer` contract — `append` (optimistic, `expectedHead`-guarded), `read`, `head`, `list`, `delete`, and `truncate` (so session time-travel / `restore` works) — and is validated against core's `checkpointerConformance` test suite.

See the [monorepo root](../..) for architecture.
