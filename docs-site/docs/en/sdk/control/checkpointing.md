# Checkpointing

Every run is **event-sourced**: the session is persisted as an append-only log of `SessionEvent`s through the `Checkpointer` contract. That buys you durable sessions (resume after a restart), and **time travel** — roll a session back to any earlier checkpoint, undoing both the conversation and the file changes the agent made. Persistence is on by default via `fileCheckpointer`; swap in the SQLite backend when several processes must share sessions.

## Use it

With the default file backend there is nothing to configure — `createLiteAgent` persists every session, and `LiteAgent` owns a current one:

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

Session management on `LiteAgent`:

| Method | Description |
| --- | --- |
| `send(input, opts?)` | Run one turn to completion in the current session; resolves to `LiteAgentResult`. |
| `sessionId` | The id `run`/`send` use when `opts.sessionId` is not passed. |
| `resume(id)` | Switch the current session to an existing id (unknown ids start empty). |
| `clear()` | Rotate to a new empty session; returns the new id. The old transcript is kept. |
| `listSessions()` | List persisted sessions (`{ id, mtime }`, most-recent first). |
| `deleteSession(id)` | Delete a persisted session transcript. |
| `compact(instructions?)` | Manually compact the current session; resolves to `{ before, after }` token counts. |

Set `sessions: false` to disable persistence entirely (session methods then reject).

## Time travel

Checkpoints are rewind anchors — one per user prompt. `restore(id, seq)` rolls a session back to just before a checkpoint: it **reverts snapshotted files** and/or **truncates the conversation**, then sets the current session to `id`.

```ts
const sessions = await agent.listSessions();
agent.resume(sessions[0].id);            // continue the most recent session

const checkpoints = await agent.listCheckpoints(agent.sessionId);
await agent.restore(agent.sessionId, checkpoints[2].seq); // undo everything after that prompt
```

| Method | Description |
| --- | --- |
| `listCheckpoints(id)` | List rewind anchors (one per user prompt) for a session, oldest first. |
| `restore(id, seq, opts?)` | Roll back to just before a checkpoint. `opts.files` (default `true`) reverts snapshotted files; `opts.conversation` (default `true`) truncates the conversation. |

Time travel works because the file tools snapshot every file before modifying it: `restore` replays those snapshots to undo changes on disk, then truncates the event log.

## Switching to the SQLite backend

The default `fileCheckpointer` is single-process. The `@lite-agent/checkpoint-sqlite` package provides `sqliteCheckpointer` — a SQLite (WAL) backend for **single-host, multi-process** setups: a server or worker pool where several processes resume and append the same sessions, with optimistic concurrency instead of silent clobbering.

| Backend | Package | Concurrency | Use when |
| --- | --- | --- | --- |
| `fileCheckpointer` (default) | `@lite-agent/sdk` | Single process | Local dev, CLI tools, one agent process per project |
| `sqliteCheckpointer` | `@lite-agent/checkpoint-sqlite` | Many processes, one host | A server or worker pool sharing sessions on one machine |

```bash
pnpm add @lite-agent/checkpoint-sqlite
```

:::info
Depends on `better-sqlite3` — a native module that compiles on install. `@lite-agent/core` is required at runtime.
:::

Pass the checkpointer to `createLiteAgent` (or `query`); it overrides the default file store:

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

### Options

`SqliteCheckpointerOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `file` | `string` | — (required) | Path to the SQLite database file. Use `":memory:"` for an ephemeral DB (per-process, nothing is shared). |
| `synchronous` | `"normal" \| "full"` | `"normal"` | SQLite durability level. `"normal"` is safe under WAL; `"full"` survives OS-level crashes at a write-latency cost. |
| `busyTimeoutMs` | `number` | `5000` | How long a competing writer waits for the write lock before erroring. Clamped to `>= 0`. |
| `integrityCheckOnOpen` | `boolean` | `false` | Run `PRAGMA quick_check` at startup; throws if the database is corrupt. |

### Concurrency model

- **WAL journaling** — `journal_mode = WAL` is set on open: concurrent readers never block, and there is a single writer at a time.
- **`BEGIN IMMEDIATE` writes** — `append` and `truncate` take the write lock up front, so a competing writer waits on `busy_timeout` instead of failing with `SQLITE_BUSY_SNAPSHOT`, then reads a fresh head and conflicts cleanly.
- **Atomic seq allocation** — each `append` is one transaction that reads the session head and inserts `seq = head + 1…n`; the database serializes concurrent appends, so seqs never interleave.
- **Reads never lock** — `read({ sinceSeq })` is a pure forward scan; it is also the primitive a server layer can use to tail events over SSE.

### Conflict handling

When two processes hold the same session, the second writer's `append` fails fast with `CheckpointConflictError` — optimistic concurrency, surfaced never swallowed:

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
Multi-**host** concurrency (networked FS, distributed writers) is out of scope for SQLite. The `Checkpointer` interface is backend-agnostic, so a future Postgres backend can cover that without kernel changes.
:::

### Checkpointer contract

`SqliteCheckpointer` implements the full core `Checkpointer` interface and passes core's `checkpointerConformance` test suite — the same suite the default `fileCheckpointer` runs against:

| Method | Behavior |
| --- | --- |
| `append(sessionId, events, expectedHead?)` | Single immediate transaction. If `expectedHead` is given and differs from the current head, throws `CheckpointConflictError`. Returns the new head seq. |
| `read(sessionId, { sinceSeq? })` | Replays `StoredEvent`s in seq order, optionally after `sinceSeq` (exclusive). |
| `head(sessionId)` | Current head seq; `0` when the session is empty or unknown. |
| `list()` | All sessions as `{ id, mtime }`, most-recent activity first. |
| `delete(sessionId)` | Removes the session's events and its sessions-table row. |
| `truncate(sessionId, toSeq)` | Drops every event with `seq > toSeq` and moves the head back. Powers time travel: `LiteAgent.restore(id, toSeq, { conversation: true })` truncates the log back to a checkpoint, as a single immediate transaction that can't interleave with a concurrent append. |

Operations: `checkIntegrity(): { ok, detail }` runs `PRAGMA quick_check` on demand; `close()` closes the database handle (call it on shutdown — a closed checkpointer cannot be reused). The database carries a `user_version` schema marker: opening a file written by a newer, incompatible version throws immediately instead of misreading the data.

## See also

- [Observability](/sdk/control/observability) — recording the same event stream for audit and debugging.
- [Background tasks](/sdk/control/background) — `background_completed` events land in the same session log.
- [Core strategies](/core/strategies) — the `Checkpointer` strategy interface.
