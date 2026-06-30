# Session Time-Travel: Restore + Durable Compaction — Design

**Date:** 2026-06-30
**Status:** Approved (brainstorming complete)

## Goal

Give consumers of the stateful `createLiteAgent` agent the ability to (a) **restore** a session to an earlier checkpoint — rolling back conversation and/or files made via `write_file`/`edit_file` — and (b) run a **manual, durable compaction** action that compresses the conversation, reports progress, notifies on completion, then stops. Both are exposed only on the stateful `LiteAgent` (not the stateless `query` facade).

## Core idea: one event log, sidecar events

lite-agent already persists each session as an ordered event log of `SessionEvent`s (`user` / `assistant` / `tool_result`), reconstructed into `Message[]` by `foldEvents`. This design adds two **sidecar** event variants on the same log:

- `file_snapshot` — captures a file's pre-mutation content, so restore can undo file changes.
- `summary` — captures a compacted view of the conversation up to a point, so compaction is durable.

Sidecar events are **skipped by `foldEvents`** when building the model-facing message history (except `summary`, which resets the base — see below), so the model context is unaffected by their presence. Because the originals stay in the log, restore and compaction compose cleanly: truncating the log past a `summary` "un-compacts"; file snapshots remain available to undo.

This matches Claude Code's checkpointing semantics, **including its limitations**: only edits made through the dedicated file tools are tracked; **files changed by `bash` are not snapshotted and cannot be restored.**

## Data model (core)

`SessionEvent` (in `packages/core/src/checkpoint.ts`) gains two variants:

```ts
export type SessionEvent =
  | { type: "user"; message: Message }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "tool_result"; result: ToolResultBlock; turn: number }
  | { type: "file_snapshot"; path: string; before: string | null; truncated?: boolean; turn: number }
  | { type: "summary"; messages: Message[]; throughSeq: number; before: number; after: number };
```

- `file_snapshot.before` — the file's content **before** this mutation; `null` if the file did not exist (undo = delete). `truncated: true` marks a file too large to snapshot (see size cap) — restore skips it and warns; it never writes a half file.
- `summary.messages` — the full compacted view of the conversation up to `throughSeq` (the compactor returns a whole `Message[]`, so we store that whole array). `before`/`after` are estimated token counts for the completion notification.

### `foldEvents` becomes type-aware

```ts
export function foldEvents(events: SessionEvent[]): Message[] {
  let messages: Message[] = [];
  let pending: ToolResultBlock[] = [];
  const flush = () => { if (pending.length) { messages.push({ role: "user", content: pending }); pending = []; } };
  for (const ev of events) {
    switch (ev.type) {
      case "tool_result": pending.push(ev.result); break;
      case "summary": pending = []; messages = [...ev.messages]; break; // reset base to compacted view
      case "user": case "assistant": flush(); messages.push(ev.message); break;
      // file_snapshot (and any future sidecar): skipped
    }
  }
  flush();
  return messages;
}
```

Because events are processed in seq order and a `summary` **replaces** everything before it while later real events append, the kernel's existing load path (`foldEvents(allEvents)`) becomes summary-aware **with no kernel change**.

### `Checkpointer.truncate?` (optional, additive)

```ts
/** Drop every event with seq > toSeq. Optional: backends that can't truncate omit it. */
truncate?(sessionId: string, toSeq: number): Promise<void>;
```

Implemented in `memoryCheckpointer` (core), `fileCheckpointer` (sdk), and the SQLite backend. `legacyStoreAdapter` omits it (the legacy whole-array Store has no seq granularity). `restore({ conversation: true })` against a backend without `truncate` throws a clear error.

### `ToolContext.recordSnapshot?` (optional, additive)

```ts
/** Record a file's pre-mutation content into the session log (for restore). Provided by the
 *  kernel only when a checkpointer is active; file-mutating tools call it before writing. */
recordSnapshot?(path: string, before: string | null, truncated?: boolean): void;
```

The kernel wires it to its existing serialized `append` helper so the `file_snapshot` event is durably ordered **before** the tool's `tool_result`. Tools that don't mutate files ignore it.

## Restore (Plan 1)

`write_file` / `edit_file` read the target's prior content and call `ctx.recordSnapshot?.(path, before, truncated)` before mutating. `before` is `null` when the file is new. Files larger than `maxSnapshotBytes` (default 1_000_000) record `{ before: null, truncated: true }`.

`LiteAgent` gains:

```ts
listCheckpoints(id: string): Promise<{ seq: number; prompt: string; ts: string }[]>;
restore(id: string, toSeq: number, opts?: { conversation?: boolean; files?: boolean }): Promise<void>;
```

- `listCheckpoints` reads the log and returns one entry per `user` event whose message is a plain-string prompt (the natural rewind anchors), newest-last.
- `restore` (both flags default `true`):
  - **files**: read events with `seq > toSeq`; for each path keep the **earliest** `file_snapshot` (its `before` is the state at `toSeq`); write each back, or delete when `before === null`; skip `truncated` ones and collect a warning list.
  - **conversation**: `checkpointer.truncate(id, toSeq)`.
  - sets `currentSessionId = id` (like `resume`).

Three Claude-Code-equivalent modes fall out: `{conversation:true,files:false}` (keep code), `{conversation:true,files:true}` (both), `{conversation:false,files:true}` (keep conversation).

## Durable compaction (Plan 2)

`LiteAgent` gains a manual action:

```ts
compact(opts?): AsyncGenerator<AgentEvent, { before: number; after: number }>;
```

Behavior (mirrors Claude Code `/compact` — an action, not a turn):
1. Read the current session's events → `foldEvents` → `messages`; `before = estimateTokens(messages)`.
2. Yield a start progress event.
3. Run the agent's configured `compactor.maybeCompact(messages, ZERO_USAGE)` → `result.messages`; `after = estimateTokens(result.messages)`.
4. Append a `summary` event `{ messages: result.messages, throughSeq: head, before, after }`.
5. Yield a completion notification `{ type: "compaction", kind: "manual", before, after }`.
6. **Return — the generator ends. No model answer, no extra output.**

The `compaction` AgentEvent's `kind` union gains `"manual"`. Composition is by calling `compact()` after `resume`/`restore` — it is the same single action, reused, never a hidden flag on `run`.

## API summary

```ts
interface LiteAgent {
  // existing
  run(...), send(...), resume(id), clear(), deleteSession(id), listSessions(), sessionId
  // new — Plan 1
  listCheckpoints(id): Promise<{ seq; prompt; ts }[]>
  restore(id, toSeq, opts?: { conversation?: boolean; files?: boolean }): Promise<void>
  // new — Plan 2
  compact(opts?): AsyncGenerator<AgentEvent, { before: number; after: number }>
}
```

## Non-goals / limitations (v1)

- **bash-made file changes are not tracked** (same as Claude Code). Only `write_file`/`edit_file`.
- Snapshots store **full prior content** (no diff/content-addressing yet); files over `maxSnapshotBytes` are marked non-restorable, not partially restored.
- Only on the stateful `createLiteAgent`; `query` is unchanged.
- No UI/TUI — this is SDK surface; progress/notification are events the consumer renders.

## Decomposition

Two independently shippable plans on a shared substrate:

- **Plan 1 — Restore:** `file_snapshot` event + `foldEvents` skip-sidecar + `Checkpointer.truncate?` (3 backends) + `ToolContext.recordSnapshot?` + kernel wiring + `write_file`/`edit_file` snapshotting + `listCheckpoints`/`restore`.
- **Plan 2 — Durable compaction:** `summary` event + `foldEvents` summary case + `compaction` kind `"manual"` + `compact()` action.

Branch: a fresh branch off `main` (B-1/B-2 already merged & released at 0.6.0).
