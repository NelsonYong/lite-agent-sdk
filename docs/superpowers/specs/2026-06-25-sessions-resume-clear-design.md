# Sessions: safe default id + external resume/clear — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming)
**Packages touched:** `@lite-agent/core` (minimal), `lite-agent` (sdk), `@lite-agent/example-cli`

## Problem

With default-on persistence, restarting the example CLI made a fresh, single-turn
conversation "remember" the whole prior conversation. Root cause is a three-way
interaction:

1. The example keeps **client-side history** (an in-memory `history` array) and passes
   the whole array to `agent.run` every turn (`examples/cli/src/main.ts`).
2. The default sessionId is a **process-local counter** `s${++sessionCounter}`
   (`packages/core/src/createAgent.ts:50`) that **resets to `s1` on every restart**.
3. The default `jsonlStore` is on, and the kernel **prepends** the persisted transcript:
   `messages = [...store.load(sessionId), ...messages]` (`packages/core/src/kernel.ts:31-33`).

Within one process the per-turn counter (`s1, s2, …`) never collides, so `load` returns
`null` each turn — no harm. **Across a restart** the counter resets to `s1` and collides
with the persisted `s1.jsonl` from the previous run: the new process's first turn loads
the old transcript, prepends it, runs, and writes the merged result back to `s1.jsonl` —
which is why that file grows on every restart. (Verified on disk: a single `s1.jsonl`
had accumulated 6 question rounds across multiple launches.)

This is also a latent SDK footgun: any consumer that does what the example does
(client-side history + default-on persistence) silently resumes a stale session whenever
the counter collides.

## Goals

- **B** — The example uses **server-side history**: a stable per-process session id; each
  turn passes only the new user message; drop the client-side `history` double-count.
- **C** — The SDK provides a **safe unique default session id** so default-on persistence
  cannot silently resume a stale session across restarts.
- Expose **session management** as a public capability on the agent: `resume(id)`,
  `clear()`, `deleteSession(id)`, `listSessions()`, and the current `sessionId`.
- The example CLI supports resume (wraps the primitives into REPL commands).

## Non-goals

- No cross-session *content* sharing / no "merge all project sessions" (explicitly rejected).
- No memory/summary layer (that is a separate future feature).
- No automatic resume-most-recent on startup; the consumer decides via `resume(id)`.
- No transcript summaries in `listSessions` (id + mtime only — cheap, no per-file parse).

## Design

Chosen approach: a **stateful sdk agent wrapper**. The core stays primitive
(`core stays primitive; orchestration in sdk`), and the **fixed core `Store` interface is
not reshaped** (`modular-blocks-fixed-interfaces`). Session-listing/deletion live on the
sdk `jsonlStore`; statefulness lives on the sdk wrapper.

### 1. Core: safe default session id (C)

`packages/core/src/createAgent.ts` — replace the counter default with a unique id:

```ts
import { randomUUID } from "node:crypto";
// ...
const sessionId = opts?.sessionId ?? randomUUID();
```

Remove the module-level `let sessionCounter = 0`. Signature unchanged; only the default
value changes from "collides across restarts" to "unique". Core tests that assert the
default id is `s1`/`s2` are updated to assert uniqueness (two runs → two distinct ids).

### 2. sdk: `jsonlStore` grows session-management (core `Store` untouched)

`packages/sdk/src/store.ts`:

```ts
export interface SessionInfo {
  id: string;
  mtime: number; // ms since epoch (fs mtime of the transcript)
}

export interface SessionStore extends Store {
  list(): Promise<SessionInfo[]>;
  delete(id: string): Promise<void>;
}

export function jsonlStore(opts: JsonlStoreOptions): SessionStore { /* ... */ }
```

- `list()`: if `dir` does not exist → `[]`. Else read `dir`, keep `*.jsonl`, `stat` each
  for `mtimeMs`, map to `{ id: <filename without ".jsonl">, mtime }`, sort by `mtime`
  descending (most-recent first). The on-disk filename already equals the sanitized id
  (`save` sanitizes via `replace(/[^a-zA-Z0-9_-]/g, "_")`), so returned ids round-trip
  through `resume`/`delete` unchanged.
- `delete(id)`: `unlink(fileFor(id))` if it exists; idempotent (missing file is a no-op).

The core `Store` interface (`load`/`save` only) is unchanged. `SessionStore` is an sdk-level
superset.

### 3. sdk: `createLiteAgent` returns a stateful `LiteAgent`

`packages/sdk/src/createLiteAgent.ts` — wrap the core agent:

```ts
export interface LiteAgent extends Agent {
  get sessionId(): string;
  resume(id: string): void;
  clear(): string;
  deleteSession(id: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
}
```

Behavior:

- At construction `currentSessionId = newSessionId()` — an sdk helper producing a unique,
  creation-sortable id: `` `s-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}` ``.
- `run/send(input, opts)` delegate to the core agent with
  `sessionId: opts?.sessionId ?? currentSessionId`. **Explicit `opts.sessionId` still wins**,
  so the recursive subagent-spawn path (`child.send([...], { signal, sessionId })`) is
  unaffected, and `query({ sessionId })` resumes that id.
- `sessionId` — getter returning `currentSessionId`.
- `resume(id)` — `currentSessionId = id` (lenient: an unknown id simply starts empty there).
- `clear()` — `currentSessionId = newSessionId(); return currentSessionId`. Does **not**
  delete the prior transcript (matches Claude Code `/clear`).
- `deleteSession(id)` / `listSessions()` — require a session-capable store. The wrapper
  captures `sessionStore = isSessionStore(store) ? store : undefined`. If undefined
  (i.e. `sessions:false` → no store, or a custom `cfg.store` lacking `list`/`delete`),
  both throw `AgentError("session management requires a session-capable store")`.
  `isSessionStore(s)` = `s && typeof s.list === "function" && typeof s.delete === "function"`.

`createLiteAgent`'s return type changes from `Agent` to `LiteAgent` (a structural superset,
so all existing callers keep compiling). `query.ts` is unchanged (it consumes `.run`).

### 4. example CLI: server-side history + resume UX

`examples/cli/src/main.ts`:

- Delete `let history: Message[] = []` and its `push`/reassign. Each prompt sends only the
  new message: `agent.run([{ role: "user", content: text }], { signal: ac.signal })`.
- Print `[session] <id>` at startup (and after `clear`/`resume`).
- REPL commands (checked before dispatch; everything else is a prompt):
  - `/sessions` → `await agent.listSessions()` → print `id  <localized mtime>` per row.
  - `/resume <id>` → `agent.resume(id)`; print `[session] <id>`.
  - `/clear` → `const id = agent.clear()`; print `[session] <id> (new)`.
  - `/delete <id>` → `await agent.deleteSession(id)`; print confirmation.
  - existing `q` / `exit` unchanged.

## Data flow / invariants

- **Single process:** one stable id; the kernel `load`s and accumulates each turn; the
  caller passes only the new message → no double-count.
- **Restart:** a new process gets a **new unique id** → clean slate; it never reads back the
  previous run's transcript. To continue, the consumer calls `resume(id)` (id obtained from
  `listSessions()` or the printed startup line).

## Error handling

- `listSessions`/`deleteSession` with no session-capable store → `AgentError` (clear message).
- `jsonlStore.list` on a missing directory → `[]` (not an error).
- `jsonlStore.delete` of a missing id → no-op (idempotent).
- `resume(id)` to an unknown id → no error; the session simply starts empty.

## Testing

sdk (`packages/sdk/test/`):

- `jsonlStore`: `list` returns ids+mtime sorted desc; empty/missing dir → `[]`;
  `delete` removes a file and is idempotent.
- wrapper: default id is unique across two `createLiteAgent` instances and is **not** `s1`;
  `resume(id)` then `run` reconstructs that session's history; `clear()` returns a new id and
  **leaves the old transcript on disk**; `deleteSession` removes it from `listSessions`;
  `listSessions`/`deleteSession` throw when `sessions:false`.
- **Regression (the reported bug):** two `createLiteAgent` instances over the **same**
  sessions dir (simulating two launches); instance 2's first `run` does **not** load
  instance 1's transcript (assert the model request / persisted file shows no carryover).

core (`packages/core/test/`):

- `createAgent` default sessionId is unique per run (update tests asserting `s1`/`s2`).

## API summary (new public surface)

- `lite-agent`: `LiteAgent`, `SessionStore`, `SessionInfo`, `newSessionId` (exported);
  `createLiteAgent(...)` now returns `LiteAgent`; `jsonlStore(...)` now returns `SessionStore`.
- New `LiteAgent` methods: `sessionId` (getter), `resume`, `clear`, `deleteSession`,
  `listSessions`.

## Compatibility

- `createLiteAgent` return widens (`Agent` → `LiteAgent`): additive, source-compatible.
- `jsonlStore` return widens (`Store` → `SessionStore`): additive.
- Core default-id change alters only the *value* of an unspecified default; the one
  observable effect is the bug fix (no cross-restart collision).
- Changeset: minor bump across the four fixed packages.
