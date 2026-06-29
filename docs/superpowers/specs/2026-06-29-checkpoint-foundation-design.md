# Checkpoint Foundation (Event-Sourced Persistence) — Design

**Status:** Approved (design phase). Scope = the foundation only; B/C/server are summarized as future work.

**Goal:** Replace lite-agent's whole-array session store with an event-sourced, append-only
checkpoint layer that is concurrency-safe for multiple clients, persists tool results mid-turn,
and provides a pluggable, community-conventional backend abstraction.

**Architecture (one line):** A pluggable `Checkpointer` strategy stores an append-only log of
`SessionEvent`s keyed by a monotonic `seq`; conversation state is a deterministic fold over the
log. Backends ship as separate packages (file default, SQLite optional).

**Tech stack:** TypeScript/ESM monorepo (existing). New optional package
`@lite-agent/checkpoint-sqlite` (SQLite, WAL mode). Driver choice is deferred to the plan:
`node:sqlite` (built-in, no native dep, but Node ≥ 22) vs `better-sqlite3` (works on the repo's
declared Node ≥ 20, but a native build dependency). The plan must reconcile this against the
monorepo's `engines.node`.

---

## 1. Why (problems with today's persistence)

The current `Store` strategy (`core/src/strategies.ts`) is `save(sessionId, messages: Message[])`
/ `load(sessionId)`. The default `jsonlStore` (`sdk/src/store.ts`) **rewrites the entire file**
with the full message array on every persist, and the kernel persists **once per turn, only
after all of a turn's tool calls complete** (`core/src/kernel.ts`). Three consequences:

1. **O(n) write per turn** — a long session re-serializes its whole history every turn.
2. **Mid-turn data loss** — with concurrent in-turn tool execution (the recently shipped Path B),
   a crash mid-turn loses *every* tool result of that turn, because nothing is persisted until the
   whole turn finishes.
3. **No concurrency safety** — two processes resuming the same session both rewrite the file;
   last-writer-wins silently clobbers, and there is no head/version check.

This design fixes all three and lays the data model that future time-travel/fork (B) builds on.

## 2. Decomposition & build order (full vision)

```
A  Checkpointer foundation      ← THIS SPEC
   event-sourced append-only log + monotonic seq
   backends: file (default) | sqlite (optional pkg)
        │
        ├─ B  Time-travel / fork   parentSeq DAG, fork(fromSeq), rewind
        └─ C  Code/file revert      shadow-git snapshots, revert/unrevert (decoupled from the conversation layer)
                │
        Server layer  HTTP API over sessions/checkpoints + SSE event tail
```

- **A is the foundation**: B's DAG/fork and the server's event tail are built on A's event log.
- **C is independent** of the conversation layer and may be built in parallel with B.
- Build order: **A → (B ∥ C) → Server**. Each gets its own spec → plan → implementation cycle.

## 3. Interfaces (core — evolves the `Store` strategy)

```ts
/** The persistence seam. Evolves the current `Store` strategy. Backend-agnostic. */
interface Checkpointer {
  /**
   * Append events to a session's log. Returns the new head seq.
   * If `expectedHead` is given and the session's current head differs, throws
   * CheckpointConflictError (optimistic concurrency for multi-client safety).
   */
  append(sessionId: string, events: SessionEvent[], expectedHead?: number): Promise<number>;
  /** Replay a session's events in seq order, optionally from `sinceSeq` (exclusive). */
  read(sessionId: string, opts?: { sinceSeq?: number }): AsyncIterable<StoredEvent>;
  /** Current head seq for a session (0 when empty/unknown). */
  head(sessionId: string): Promise<number>;
  /** List known sessions (id + updated time, most-recent first). */
  list(): Promise<SessionInfo[]>;
  /** Delete a session's entire log. */
  delete(sessionId: string): Promise<void>;
}
```

core also exports two pure helpers:

- `foldEvents(events: StoredEvent[] | SessionEvent[]): Message[]` — reconstruct conversation state.
- `legacyStoreAdapter(store: Store): Checkpointer` — wrap an existing whole-array `Store` so old
  stores keep working unchanged (its `append` folds the full state and calls `store.save`,
  i.e. the original O(n) behavior; `read` yields the folded messages as synthetic events).

`CheckpointConflictError extends AgentError` (new error class in `core/src/events.ts`).

## 4. Data model (append-only event log)

```ts
type SessionEvent =
  | { type: "user";        message: UserMessage }            // a user input message
  | { type: "assistant";   message: AssistantMessage }       // appended after the model stream completes (text + tool_calls)
  | { type: "tool_result"; result: ToolResultBlock; turn: number } // appended as EACH tool finishes — mid-turn durability
  | { type: "compaction";  before: number; after: number };  // records a compaction boundary

type StoredEvent = {
  seq: number;              // monotonic per session, assigned atomically by the backend
  sessionId: string;
  parentSeq: number | null; // the seq this event follows; linear (seq-1) in A, reserved for B's DAG
  ts: string;               // ISO-8601
  event: SessionEvent;
};
```

**Fold rule (`foldEvents`)** — reproduces today's kernel message sequence exactly:

- `user` / `assistant` events push their message verbatim.
- **consecutive** `tool_result` events coalesce into a single `{ role: "user", content: [ToolResultBlock…] }`
  message, flushed when a non-`tool_result` event follows. (The kernel currently emits one user
  message holding all of a turn's tool results; coalescing reconstructs that shape.)
- `compaction` events are markers consumed by the compactor; they do not themselves add a message.

Maps to community conventions: append-only log + parent links (Claude Code's JSONL + `parentUuid`
DAG); per-message/part rows (OpenCode's SQLite `messages`/`parts`).

## 5. Kernel integration / when events are written

The kernel switches its persistence seam from `Store` to `Checkpointer`. Writes move from
"rewrite the whole array once per turn" to **fine-grained appends at state-change points**:

| Point in the turn | Event appended |
|---|---|
| Run starts / user input added | `user` |
| Model stream completes | `assistant` |
| **Each tool call completes** (inside the concurrent pool) | `tool_result` (one per call) |
| A compaction runs | `compaction` |

- **Load**: `read(sessionId)` → `foldEvents` → `Message[]` (replaces reading the whole file).
- core stays primitive: the kernel depends only on the `Checkpointer` interface. Existing `Store`
  implementations keep working via `legacyStoreAdapter` (same old behavior, no event granularity).
- Appending each `tool_result` the moment it resolves is what closes the mid-turn data-loss gap
  introduced by concurrent tools (mirrors LangGraph's per-node "pending writes").

## 6. Concurrency model (multi-client)

Target: **multiple processes on one host** (the chosen "server / multi-client" deployment), served
by SQLite WAL. Multi-*host* (networked FS / distributed) is explicitly out of scope here and is the
role of a future Postgres backend (the interface already allows it).

- **Atomic seq allocation**: append is a single transaction that computes
  `seq = COALESCE(MAX(seq),0)+1` for the session and inserts; the backend serializes concurrent
  appends. Append-only means no rewrite races.
- **Optimistic concurrency**: when `expectedHead` is supplied and the session head has advanced
  (another client appended), `append` throws `CheckpointConflictError`; the caller reloads (or, in
  phase B, forks). This removes the "two clients silently interleave into one session" footgun.
- **SQLite specifics**: WAL mode (`journal_mode=WAL`) for concurrent readers + a single writer;
  `BEGIN IMMEDIATE` for append transactions; `busy_timeout` so a competing writer waits rather than
  erroring immediately.
- **Reads never lock**: `read({ sinceSeq })` is a pure forward scan — also the primitive the future
  server layer uses to tail events over SSE.

## 7. Backends & packaging (community convention: one package per backend)

| Package | Backend | When |
|---|---|---|
| `lite-agent` (sdk) | `fileCheckpointer` — append-only JSONL, one line per `StoredEvent` | **default**, dev/local |
| `@lite-agent/checkpoint-sqlite` (new) | SQLite + WAL | single-host multi-process |

- **Default** stays a local file; SQLite is opt-in. (Postgres is intentionally **not** shipped now;
  the backend-agnostic interface keeps the door open to add `@lite-agent/checkpoint-postgres` later.)
- SQLite schema:
  - `events(session_id TEXT, seq INTEGER, parent_seq INTEGER, ts TEXT, type TEXT, payload TEXT,
    PRIMARY KEY(session_id, seq))`
  - `sessions(id TEXT PRIMARY KEY, created TEXT, updated TEXT, head INTEGER)`
- **Backend conformance suite**: one shared test suite (append/read ordering/head/list/delete +
  concurrent-append + head-conflict) that every backend must pass — mirrors LangGraph's checkpointer
  test suite convention.

## 8. Migration / backward compatibility

Per decision, **no migration of old data** — convenience over preservation:

- The new `fileCheckpointer` uses the event-log format. Old whole-array `<sid>.jsonl` transcripts
  are **not read or converted**; on first use the new format takes over. Users may delete the old
  `sessions/` directory; the cleanup sweeper may also remove unrecognized old files.
- The `Store` type and `legacyStoreAdapter` remain for any code that injected a custom `Store`.
- `SessionStore.list`/`delete` are subsumed by `Checkpointer.list`/`delete`.
- Default-on sessions switch from `jsonlStore` to `fileCheckpointer` (still resumable; format change
  is acceptable since old data is discarded).

## 9. Error handling

- **Atomic append**: each `append` call is one transaction; a half-written `tool_result` is either
  fully present or absent. Replay reconstructs state up to the last durable event.
- **Conflict**: `CheckpointConflictError` is surfaced (not swallowed); the caller decides reload vs
  fork.
- **Crash mid-turn**: on resume, replay yields committed messages. If the trailing `assistant`
  message has `tool_call`s without matching `tool_result`s, the desired behavior is to **re-run only
  the missing tool calls** (mirrors LangGraph "completed work is not re-run"). This mid-turn re-run
  is a **deferred sub-phase** of A — the MVP guarantees correct replay; re-running missing calls
  lands after. (Caveat to document then: re-run assumes tool idempotency.)

## 10. Testing

- **Backend conformance suite** run against `fileCheckpointer` and the SQLite backend: append
  returns monotonic head; read returns seq order; `sinceSeq` filters; head/list/delete; concurrent
  appends serialize; `expectedHead` mismatch throws `CheckpointConflictError`.
- **`foldEvents` golden tests**: event sequences (incl. coalescing consecutive `tool_result`s) →
  expected `Message[]`.
- **Kernel integration**: a run appends the expected event sequence; resume replays to the same
  `Message[]`; per-tool-result events appear as each tool finishes.
- **Crash recovery**: a truncated log replays to a correct partial state.
- **legacyStoreAdapter**: an old whole-array `Store` still loads/persists through the new seam.

## 11. Out of scope (future specs)

- **B — Time-travel / fork**: `parentSeq` DAG, `fork(fromSessionId, atSeq)`, rewind to a past turn.
- **C — Code/file revert**: shadow-git snapshots (`git write-tree` trees, work-tree → project dir),
  `revert`/`unrevert`, decoupled from the conversation layer.
- **Server layer**: HTTP API over sessions/checkpoints + SSE event tail.
- **Postgres backend** (`@lite-agent/checkpoint-postgres`) for multi-host/distributed concurrency.
- **Mid-turn re-run** of missing tool calls (deferred sub-phase of A, per §9).

## 12. Decisions log

- Event-sourced append-only log (not snapshot-per-turn, not minimal SQLite-row). — chosen for
  concurrency safety + mid-turn durability + DAG-readiness.
- Ship **file (default) + SQLite** backends only; Postgres deferred but interface kept agnostic.
- Multi-client concurrency = SQLite WAL + optimistic `expectedHead`; no advisory-lock layer in A.
- **No data migration**; old transcripts discarded.
- Mid-turn re-run of missing tool calls is deferred; MVP guarantees correct replay only.
