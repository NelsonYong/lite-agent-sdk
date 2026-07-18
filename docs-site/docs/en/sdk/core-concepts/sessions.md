# Sessions

A session is a persistent, resumable conversation. With `createLiteAgent`, every run is **event-sourced to disk** through a `Checkpointer`, and the agent owns a *current session*: successive `send()` calls share the full conversation, you can list and resume past sessions across restarts, and you can roll a session back to any earlier prompt. You get durable multi-turn agents without writing any storage code.

Nothing to enable — persistence is on by default via the built-in `fileCheckpointer`:

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

## Managing sessions

`LiteAgent` exposes the whole session lifecycle:

| Method | Description |
| --- | --- |
| `send(input, opts?)` | Run one turn to completion in the current session; resolves to `LiteAgentResult`. |
| `sessionId` | The id `run`/`send` use when `opts.sessionId` is not passed. |
| `resume(id)` | Switch the current session to an existing id (unknown ids start empty). |
| `clear()` | Rotate to a new empty session; returns the new id. The old transcript is kept. |
| `listSessions()` | List persisted sessions (`{ id, mtime }`, most-recent first). |
| `deleteSession(id)` | Delete a persisted session transcript. |
| `listCheckpoints(id)` | List rewind anchors (one per user prompt) for a session, oldest first. |
| `restore(id, seq, opts?)` | Roll a session back to just before a checkpoint: reverts snapshotted files (`files`, default `true`) and/or truncates the conversation (`conversation`, default `true`). Sets the current session to `id`. |
| `compact(instructions?)` | Manually compact the current session; streams progress events and resolves to `{ before, after }` token counts. |

```ts
const sessions = await agent.listSessions();
agent.resume(sessions[0].id);            // continue the most recent session

const checkpoints = await agent.listCheckpoints(agent.sessionId);
await agent.restore(agent.sessionId, checkpoints[2].seq); // undo everything after that prompt
```

Time travel works because the file tools snapshot every file before modifying it: `restore` replays those snapshots to undo changes on disk, then truncates the event log. See [Checkpointing](/sdk/control/checkpointing) for the full rewind model.

Set `sessions: false` to disable persistence entirely (session methods then reject).

## Persisting to external storage

The default `fileCheckpointer` is single-process. When several processes on one host must share sessions — an HTTP server, a worker pool, parallel CLI runs — swap in the SQLite backend from `@lite-agent/checkpoint-sqlite`:

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

The SQLite backend gives you WAL-based concurrent readers, atomic seq allocation, and **optimistic concurrency**: a stale writer gets a clean `CheckpointConflictError` instead of silently clobbering the log. Any custom backend that implements the core `Checkpointer` interface (`append` / `read` / `head` / `list` / `delete` / `truncate`) works the same way — pass it via the `checkpointer` (or `store`) option, which overrides `sessions`.

:::info
Multi-**host** concurrency (networked FS, distributed writers) is out of scope for SQLite. The `Checkpointer` interface is backend-agnostic, so a future network backend can cover that without kernel changes.
:::

## See also

- [Checkpointing](/sdk/control/checkpointing) — the `listCheckpoints` / `restore` time-travel model in detail.
- [Events](/sdk/core-concepts/events) — the `SessionEvent` stream that gets persisted.
- [Agent loop](/sdk/core-concepts/agent-loop) — what happens inside each turn of a session.
