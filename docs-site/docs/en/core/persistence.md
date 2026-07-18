# Session persistence

lite-agent persists every session as an append-only, event-sourced log behind the `Checkpointer` contract. Because the log — not the message array — is the source of truth, you get crash recovery, optimistic concurrency, and time travel (fork a session from any point) for free, and the storage backend is a swappable strategy: in-memory for tests, a file store in the SDK by default, or SQLite when several processes share sessions.

## Enabling persistence

Pass any `Checkpointer` to `createAgent` (or to the SDK's `query` / `createLiteAgent`, which default to a file-based store):

```ts
import { createAgent, memoryCheckpointer } from "@lite-agent/core";

const agent = createAgent({
  model: myProvider,
  checkpointer: memoryCheckpointer(), // ephemeral; see below for durable backends
});

const result = await agent.send("hello", { sessionId: "s_1" });
// Resume later: same sessionId replays the log and rebuilds the conversation.
```

## Checkpointer primitives

The canonical persisted unit is a `SessionEvent` (`user`, `assistant`, `tool_started`, `tool_result`, `file_snapshot`, `artifact_verified`, `permission_decision`, `summary`, `context_view`), stored as a `StoredEvent` with a monotonic `seq` and `parentSeq` link.

```ts
interface Checkpointer {
  append(sessionId: string, events: SessionEvent[], expectedHead?: number): Promise<number>;
  read(sessionId: string, opts?: { sinceSeq?: number }): AsyncIterable<StoredEvent>;
  head(sessionId: string): Promise<number>;
  list(): Promise<SessionInfo[]>;
  delete(sessionId: string): Promise<void>;
  truncate?(sessionId: string, toSeq: number): Promise<void>;
}
```

Passing `expectedHead` to `append` gives optimistic concurrency — a mismatch throws `CheckpointConflictError`. Because the log is the source of truth, `truncate` + replay is time travel: fork a session from any point.

Building blocks exported from `@lite-agent/core`:

- `memoryCheckpointer()` — the in-memory implementation, for tests and ephemeral runs.
- `foldEvents(events)` — rebuilds the conversation from a log: consecutive `tool_result` events coalesce into one user message (reproducing the kernel's turn shape), and a `summary` event resets the transcript.
- `storeEvents(sessionId, fromSeq, events)` — stamps raw `SessionEvent`s into `StoredEvent`s with `seq`/`parentSeq`/`ts`; the building block for writing your own backend.
- `legacyStoreAdapter(store)` — wraps a legacy whole-array `Store` as a `Checkpointer`, so existing storage keeps working.

:::tip
Validate any custom backend against the [`checkpointerConformance` suite](/core/testing) — the same suite the built-in backends run against.
:::

## The SQLite backend

`@lite-agent/checkpoint-sqlite` is a durable `Checkpointer` for **single-host, multi-process** setups. Two backends ship today:

| Backend | Package | Concurrency | Use when |
| --- | --- | --- | --- |
| `fileCheckpointer` (default) | `@lite-agent/sdk` | Single process | Local dev, CLI tools, one agent process per project |
| `sqliteCheckpointer` | `@lite-agent/checkpoint-sqlite` | Many processes, one host | A server or worker pool where several processes resume/append the same sessions |

Choose the SQLite backend when:

- Multiple processes on one host (HTTP server, job workers, parallel CLI runs) share sessions.
- You need **optimistic concurrency**: a stale writer gets a clean `CheckpointConflictError` instead of silently clobbering the log.
- You want one queryable database file instead of a directory of JSONL transcripts.

:::warning
Multi-**host** concurrency (networked FS, distributed writers) is out of scope for SQLite. The `Checkpointer` interface is backend-agnostic, so a future `@lite-agent/checkpoint-postgres` can cover that without kernel changes.
:::

```bash
pnpm add @lite-agent/checkpoint-sqlite
```

:::info
Depends on `better-sqlite3` — a native module that compiles on install. `@lite-agent/core` is required at runtime.
:::

### Using the SQLite checkpointer

Pass it to `createLiteAgent` (or `query`); it overrides the default file store:

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

### Concurrency model

- **WAL journaling** — `journal_mode = WAL` is set on open: concurrent readers never block, and there is a single writer at a time.
- **`BEGIN IMMEDIATE` writes** — `append` and `truncate` take the write lock up front, so a competing writer waits on `busy_timeout` instead of failing with `SQLITE_BUSY_SNAPSHOT`, then reads a fresh head and conflicts cleanly.
- **Atomic seq allocation** — each `append` is one transaction that reads the session head and inserts `seq = head + 1…n`; the database serializes concurrent appends, so seqs never interleave.
- **Reads never lock** — `read({ sinceSeq })` is a pure forward scan; it is also the primitive a server layer can use to tail events over SSE.

### Contract behavior

`SqliteCheckpointer` implements the full core `Checkpointer` interface:

| Method | Behavior |
| --- | --- |
| `append(sessionId, events, expectedHead?)` | Single immediate transaction. If `expectedHead` is given and differs from the current head, throws `CheckpointConflictError`. Returns the new head seq. |
| `read(sessionId, { sinceSeq? })` | Replays `StoredEvent`s in seq order, optionally after `sinceSeq` (exclusive). |
| `head(sessionId)` | Current head seq; `0` when the session is empty or unknown. |
| `list()` | All sessions as `{ id, mtime }`, most-recent activity first. |
| `delete(sessionId)` | Removes the session's events and its sessions-table row. |
| `truncate(sessionId, toSeq)` | Drops every event with `seq > toSeq` and moves the head back. Powers time travel. |

The backend passes core's `checkpointerConformance` test suite — the same suite the default `fileCheckpointer` runs against.

### Options

```ts
export interface SqliteCheckpointerOptions {
  file: string;
  synchronous?: "normal" | "full";
  busyTimeoutMs?: number;
  integrityCheckOnOpen?: boolean;
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `file` | `string` | — (required) | Path to the SQLite database file. Use `":memory:"` for an ephemeral DB (per-process, nothing is shared). |
| `synchronous` | `"normal" \| "full"` | `"normal"` | SQLite durability level. `"normal"` is safe under WAL; `"full"` survives OS-level crashes at a write-latency cost. |
| `busyTimeoutMs` | `number` | `5000` | How long a competing writer waits for the write lock before erroring. Clamped to `>= 0`. |
| `integrityCheckOnOpen` | `boolean` | `false` | Run `PRAGMA quick_check` at startup; throws if the database is corrupt. |

:::tip
The database carries a `user_version` schema marker. Opening a file written by a newer, incompatible version of this package throws immediately instead of misreading the data.
:::

### Conflict handling

When two processes hold the same session, the second writer's `append` fails fast:

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

This is optimistic concurrency: the conflict is surfaced, never swallowed, so two clients can't silently interleave into one session. The caller decides whether to reload — or, with session time travel, to fork from an earlier point.

### Time travel

`truncate` is what makes session restore possible on this backend: `LiteAgent.restore(id, toSeq, { conversation: true })` truncates the log back to a checkpoint. It runs as a single immediate transaction, so a rewind can't interleave with a concurrent append.

### Operations

```ts
const ok = checkpointer.checkIntegrity();
if (!ok.ok) console.error("database corrupt:", ok.detail);

checkpointer.close();
```

- `checkIntegrity(): { ok: boolean; detail: string }` — runs `PRAGMA quick_check` on demand (same check as `integrityCheckOnOpen`).
- `close(): void` — closes the database handle. Call it on shutdown; a closed checkpointer cannot be reused.

## See also

- [Testing utilities](/core/testing) — `checkpointerConformance` for validating custom backends.
- [Context compaction](/core/compaction) — the ContextEngine's durable event log builds on the same primitives.
- [Strict local assembly](/core/local) — wires the SQLite checkpointer in with hardened settings.
- [The nine strategies](/core/strategies) — the legacy `Store` seam and `legacyStoreAdapter`.
