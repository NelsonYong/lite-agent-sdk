# Background Tasks Follow-up — Daemon Support & Blocking Subagents

**Status:** Design
**Date:** 2026-07-08
**Corrects:** `2026-07-08-background-tasks-design.md` (shipped in `@lite-agent/core` 0.9.0 / `lite-agent` 0.9.0)

> **Note on subagent scope:** this spec keeps subagent `background` as an explicit opt-in (default flips to blocking). If on review you'd rather remove backgrounded subagents entirely (Agent always blocks, drop the flag), say so and we cut that section.

## 1. Why this follow-up exists

The 0.9.0 background feature is right for **finite** background work but has two defects that this spec removes.

### Defect A — `join` hangs on never-exiting processes (a real bug)

`bash`'s background path runs `await execAsync(cmd, { signal })`, which resolves **only when the process exits** (`packages/sdk/src/tools/bash.ts:33-42`). A `dev server`, a `watch`, a `tail -f` never exits, so it stays permanently `pending`. Once the model stops calling tools, the kernel's dry-out **join** blocks on `bg.waitNext(signal)` (`packages/core/src/kernel.ts:176-181`) with no completion ever arriving — the run hangs until whole-run abort or `KillBackground`. The kernel comment already concedes this (`kernel.ts:169-172`).

This is the exact category the tool advertises ("servers, watchers, slow test suites" — `bash.ts:48`), so the feature is broken for its headline use case. Even the legitimate "start a dev server, then run e2e against it" flow hangs at the end because nothing kills the server.

**Root cause:** the design conflates two different lifecycles under one "background task" — a **finite job** whose result you want to wait for, and a **long-lived daemon** you started as a side effect. `join` is correct for the former and actively wrong for the latter.

### Defect B — subagents default to background, which costs a wasted turn

`Agent` defaults to `run_in_background: true` (`packages/sdk/src/tools/agent.ts:46`). But delegation is usually "compute X, I need it to proceed." With background-default, the model gets a placeholder, has nothing to act on, stops calling tools, dry-out join waits for the batch, injects the result, and the model resumes — an **extra model turn and extra context for zero wall-clock benefit** whenever the model has no other independent work to do meanwhile. Background only pays off when the model *does* have parallel work; that is the rarer case, so it should be opt-in, not the default. A subagent batch is also always finite, so when it *is* backgrounded it should remain joinable.

## 2. What changes (summary)

1. Split background tasks into two **kinds** in the core primitive: `joinable` (finite; push + join) and `detached` (daemon; never joins, output pollable, killed on run-end).
2. `bash` background → **detached**, backed by a streaming child process, readable via a new **`BashOutput`** tool.
3. `Agent` background (opt-in) → **joinable**; default flips to **blocking** (`run_in_background: false`).
4. Kernel `join` gates run termination on **joinable pending only**; detached tasks never block it. Both kinds still push a `<background-task-completed>` note when they finish, and both are still cancelled on abort and on the maxTurns/run-end exit.

Everything else from 0.9.0 (the registry-per-run, turn-boundary injection, `background` master switch, `KillBackground`, `cancelAll` on abort/run-end) is kept.

## 3. Core primitive changes (`packages/core/src/background.ts`)

### 3.1 Task kind on `spawn`

```ts
export type BackgroundKind = "joinable" | "detached";

export interface BackgroundSpawnOptions {
  label: string;
  /** Default "joinable". "detached" = long-lived; never gates run termination, output pollable. */
  kind?: BackgroundKind;
  /**
   * The work. Resolves to the final content string; a throw becomes an isError completion.
   *  - signal: task-scoped abort (KillBackground / run-abort)
   *  - emit:   run-level event sink (survives the per-turn channel)
   *  - write:  append a chunk to this task's live output buffer (used by detached tasks
   *            so BashOutput can read incremental output; joinable tasks may ignore it)
   */
  run: (signal: AbortSignal, emit: (e: AgentEvent) => void, write: (chunk: string) => void) => Promise<string>;
}
```

`run` gains a third positional arg `write`. Existing joinable callers ignore it — additive at the call site.

### 3.2 New registry surface

```ts
export interface BackgroundTasks {
  spawn(opts: BackgroundSpawnOptions): BackgroundHandle;

  /** Count of JOINABLE tasks still running — the only kind that gates run termination. */
  pendingJoinable(): number;
  /** Count of detached tasks still running (for diagnostics / listing). */
  pendingDetached(): number;

  hasCompleted(): boolean;
  takeCompleted(): BackgroundCompletion[];
  /** Resolve when the next JOINABLE task completes, or on abort, or if none are joinable-pending. */
  waitNextJoinable(signal: AbortSignal): Promise<void>;

  /** Read a detached task's NEW output since the last read (read cursor tracked per id
   *  inside the registry — the model is the only reader). null if the id is unknown/not detached. */
  read(id: string, opts?: { filter?: RegExp }): BackgroundRead | null;
  /** List live detached tasks (id + label) for BashOutput discovery / KillBackground. */
  listDetached(): BackgroundHandle[];

  cancel(id: string): boolean;
  cancelAll(): void;
}

export interface BackgroundRead {
  /** New output since the previous read of this id, after optional `filter`. */
  output: string;
  /** True once the process has exited (its completion note has/will also be injected). */
  done: boolean;
}
```

- `pending()` is renamed to `pendingJoinable()` (the join loop's real intent); `pendingDetached()` is additive.
- `waitNext` → `waitNextJoinable` (never waits on detached tasks).
- Detached tasks keep an append-only output buffer (a bounded ring — cap e.g. 1 MB, drop oldest) fed by `write`. The registry holds one **read cursor per detached id**, so successive `read(id)` calls return only output appended since the previous read (mirrors Claude Code's incremental `BashOutput`); the first read returns from the start. No cursor is threaded through `ToolContext` — the tool ctx does not carry `state` (`kernel.ts:210`).
- A **detached** task that *does* exit still records a `BackgroundCompletion` and is injected at the next turn top exactly like today — you get the push note *and* it never blocked the run.

### 3.3 `finish` / kind bookkeeping

The internal `running` map entries carry their `kind`. `finish` moves a task to `completed` for both kinds; `notify()` only wakes `waitNextJoinable` when a **joinable** task finished (a detached task exiting must not un-block a join it was never part of, but its completion is still delivered at the next turn top).

## 4. Kernel changes (`packages/core/src/kernel.ts`)

Only the dry-out join branch changes. Replace the current condition:

```ts
// before
if (bg && (bg.pending() > 0 || bg.hasCompleted())) {
  yield { type: "turn_end", turn, stopReason: "stop" };
  if (!bg.hasCompleted()) await bg.waitNext(signal);
  turn--;
  continue;
}
```

```ts
// after — only JOINABLE work gates termination; detached daemons never block the run
if (bg && (bg.pendingJoinable() > 0 || bg.hasCompleted())) {
  yield { type: "turn_end", turn, stopReason: "stop" };
  if (!bg.hasCompleted()) await bg.waitNextJoinable(signal);
  turn--;
  continue;
}
```

- Turn-top injection (`kernel.ts:98-105`), `background_completed` event, and `cancelAll()` on abort (`kernel.ts:87`) and on run-end (`kernel.ts:243`) are unchanged. `cancelAll()` on run-end is now what guarantees detached daemons don't leak past the run.
- Consequence, stated plainly: a run can now `stop` with detached daemons still running; they are killed at run-end. This is intended — a daemon is a side effect, not a result to wait for.

## 5. SDK changes

### 5.1 `bash` → detached + streaming (`packages/sdk/src/tools/bash.ts`)

- Background path spawns with `kind: "detached"`.
- Replace `execAsync` (buffered, exit-only) with a streaming `child_process.spawn` whose `stdout`/`stderr` `data` events call `write(chunk)`. `run` resolves with a short tail summary on exit (the full stream lives in the buffer read via `BashOutput`). Abort via `signal` (`spawn` supports `{ signal }`).
- Return string: `` `[background:${id}] started: ${cmd}. Read output with BashOutput(${id}); it will not block this run and is stopped when the run ends.` ``
- Foreground path (`runSync`, `SYNC_OPTS` timeout) is unchanged.
- Description keeps servers/watchers — they are now correctly supported — but points to `BashOutput` instead of promising auto-delivery.

### 5.2 New `BashOutput` tool (`packages/sdk/src/tools/bashOutput.ts`)

```ts
name: "BashOutput"
description: "Read new output from a background (detached) command started with bash run_in_background:true, by its bg_… id. Optional `filter` is a regex; only matching lines are returned. Returns only output since your last read."
schema: z.object({ id: z.string(), filter: z.string().optional() })
execute: (input, ctx) => {
  if (!ctx.background) return "Background tasks are disabled.";
  const filter = input.filter ? new RegExp(input.filter) : undefined;
  const r = ctx.background.read(input.id, { filter });
  if (!r) return `No detached background task with id '${input.id}'.`;
  return (r.output || "(no new output)") + (r.done ? "\n[process exited]" : "");
}
```

- Incremental reads are stateful in the **registry** (one read cursor per detached id), not in the tool — so repeated `BashOutput` calls return only *new* output without `ToolContext` carrying `state`.
- Registered alongside `KillBackground`, gated by the same `if (cfg.background !== false)` in `createLiteAgent.ts`; exported from the sdk/tools barrels.

### 5.3 `Agent` → blocking default, joinable when backgrounded (`packages/sdk/src/tools/agent.ts`)

- `schema`: `run_in_background: z.boolean().optional().default(false)` (was `true`).
- Dispatch guard changes to opt-in: `if (run_in_background === true && ctx.background) { spawn({ kind: "joinable", ... }) }`. (Note the flip from `!== false` to `=== true`: with blocking as the default, a schema-bypassed `undefined` must fall through to blocking, not background.)
- Backgrounded batch spawns with `kind: "joinable"` (finite → keeps push+join). `runBatch(signal, emit)` and run-level emit routing are unchanged.
- Description rewritten: **blocking by default** (results returned directly in this call); `run_in_background: true` for the rarer fan-out-and-forget case (placeholder now, aggregated results delivered by notification when all finish).

### 5.4 `KillBackground` (`packages/sdk/src/tools/killBackground.ts`)

Unchanged — `cancel(id)` already covers both kinds.

## 6. Compatibility

- **Behavioral change (revert of a 0.9.0 behavioral change):** `Agent` now blocks by default. Consumers who relied on 0.9.0's implicit backgrounding must pass `run_in_background: true`. Flag loudly in the next changelog. Per the repo's 0.x convention → **minor** bump (`core` and `sdk`).
- `bash run_in_background:true` no longer auto-delivers finite output; the model reads it via `BashOutput`. This is a semantics change for background bash (push → poll) but removes the hang and is Claude-Code-consistent.
- Additive: `pendingDetached`, `read`, `listDetached`, `BashOutput`, the `kind`/`write` params. The `pending`→`pendingJoinable` and `waitNext`→`waitNextJoinable` renames are internal to core (kernel is the only caller) — safe to rename, but note them as core-internal API changes.

## 7. Testing

Core (`packages/core/test/`):
- A **detached** task that never resolves does NOT block dry-out: the run reaches `stop`, and the task is `cancelAll`'d at run-end (regression for Defect A).
- A **joinable** task still blocks dry-out until it settles (unchanged guarantee).
- Mixed run: one detached (never exits) + one joinable (finite) → run joins on the joinable, then stops; detached is cancelled.
- `read()` returns incremental output across two reads via `cursor`; `filter` narrows lines; `read` on an unknown/joinable id → null.
- Detached task that *does* exit still injects a `<background-task-completed>` note.

SDK (`packages/sdk/test/`):
- `bash run_in_background:true` on a `sleep`-style long process returns the started placeholder and does not block; `BashOutput` reads streamed output; `KillBackground` stops it.
- `Agent` with no `run_in_background` **blocks** and returns aggregated results directly (regression for Defect B); with `run_in_background:true` returns the placeholder and results arrive via notification (joinable).
- `background:false` still disables everything, including `BashOutput` ("Background tasks are disabled.").
- Update the existing `subagents.test.ts` / `defaults.test.ts` that asserted the old background-default.

## 8. Out of scope

- Finite background **bash** with push+join (a separate flag to say "this command terminates, auto-deliver it"). Not worth the extra surface now; poll via `BashOutput` covers it.
- Persisting detached-task output across `resume` — buffers are in-memory, per-run; a resumed session starts fresh.
- Cross-run/daemon supervision (restart on crash, health checks).

## 9. Open questions

1. Detached output buffer cap and overflow policy — proposed 1 MB ring, drop-oldest, with a `[…truncated]` marker. OK?
2. Should a `stop` that leaves detached daemons running surface a one-line notice to the consumer (e.g. a final event listing what was killed), or is silent `cancelAll` fine?
