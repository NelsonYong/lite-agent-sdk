# Background Tasks: Non-Blocking bash + Subagents with Join-on-Return — Design

**Date:** 2026-07-08
**Status:** Approved (brainstorming complete)

## Goal

Let a tool call run **in the background** instead of blocking the assistant turn, matching Claude Code's behavior: the call returns a placeholder immediately, the work keeps running, and its result is **injected back into the main agent as a notification** at a later turn boundary. Two policies differ from Claude Code, by decision:

- **bash** is foreground by default; the model opts a single command into the background per call (`run_in_background`).
- **subagents** (the `Agent` tool) are **background by default**; the model can force a blocking dispatch per call (`run_in_background: false`). One `Agent` call (a whole batch of `tasks`) produces **one** aggregated notification when all its children finish.

The whole feature is gated by a top-level `background` option, **default on**.

## Lifecycle decision: run-内 join (join-on-return)

A single `run()` **stays alive until every background task it spawned has finished**. If the model runs dry (produces no tool calls) while background tasks are still running, the kernel does **not** stop — it blocks at the turn boundary, waits for the next completion, injects it as a notification, and lets the model continue. `run()` never returns with unfinished background work.

This is deliberately the same mechanism the kernel already uses for `SteerController`: `steer()` injects a user message before the next model turn, and `followUp()` resurrects a run that would otherwise stop. Background-completion is a **kernel-managed sibling** of those two. That precedent is why this primitive belongs in `core` (where `SteerController` already lives), not in the sdk.

Explicitly **not** in scope: cross-run detached background, persistence of background work across process restarts, a `BashOutput`-style "peek partial output" tool, and real-time (sub-turn-boundary) streaming of background events. See Non-Goals.

## Core idea: a generic background primitive that knows nothing about subagents

`core` gains one new strategy-adjacent primitive, `BackgroundTasks`, threaded into `ToolContext` as `ctx.background` — exactly like the existing optional `ctx.approval` / `ctx.sandbox` / `ctx.input`. It manages *tasks*: opaque promises with a label. It has no concept of "bash" or "subagent". The **policy** — which tools go background, and their defaults — lives entirely in the sdk tools. This honors the existing separation (core = primitives, sdk = orchestration/policy).

## Data model (core)

New file `packages/core/src/background.ts`, sibling to `steer.ts` and same style:

```ts
export interface BackgroundHandle { id: string; label: string }

export interface BackgroundSpawnOptions {
  label: string;                                        // display: "npm test" / "3 subagents"
  run: (signal: AbortSignal, emit: (e: AgentEvent) => void) => Promise<string>;
}

export interface BackgroundCompletion {
  id: string;
  label: string;
  content: string;
  isError: boolean;
}

export interface BackgroundTasks {
  /** Register and start a task; returns immediately with its handle. */
  spawn(opts: BackgroundSpawnOptions): BackgroundHandle;
  /** How many tasks are still running. */
  pending(): number;
  /** True if there are finished-but-not-yet-delivered completions. */
  hasCompleted(): boolean;
  /** Kernel drains delivered completions at a turn boundary. */
  takeCompleted(): BackgroundCompletion[];
  /** Block until at least one more task completes, or `signal` aborts. */
  waitNext(signal: AbortSignal): Promise<void>;
  /** Cancel one running task by id (aborts its linked controller). */
  cancel(id: string): boolean;
  /** Cancel all running tasks (called on run abort). */
  cancelAll(): void;
}
```

### Behavior contract

- `spawn` assigns an id (`bg_` + short hex), links a per-task `AbortController` to the run's `AbortSignal`, invokes `run(taskSignal, emit)`, and stores the settled result (or `isError` on throw) into a completed queue. It never awaits `run` itself.
- `run`'s `emit` routes to the **kernel's run-level event queue** (the one drained by `drain()`), **not** the per-turn tool channel. This is essential: a background subagent keeps emitting events after the turn that spawned it has ended and `end()`-ed its channel; routing to the run-level queue means those events surface at subsequent turn-boundary drains instead of being dropped.
- `cancel` / `cancelAll` abort the task's controller; the task settles **asynchronously** through the same single `finish` path (so cancel-racing-completion still yields exactly one completion) and then leaves `pending`. A cancelled task's `isError` depends on how its `run` reacts to the abort: background bash rejects with an AbortError → `isError: true`; a backgrounded subagent batch whose children stop cleanly returns partial text → `isError: false`. (So "cancelled" does not universally mean `isError: true`.)
- `waitNext` is abort-aware: it resolves when a task completes **or** when `signal` aborts, never sleeping past an abort.

`ToolContext` (in `middleware.ts` / `strategies.ts`) gains:

```ts
background?: BackgroundTasks;   // optional; tools guard, provided by the kernel when enabled
```

## Kernel changes (`kernel.ts`)

The kernel constructs the registry and hands its run-level `emit` to it, then passes `bg` into each `tool.execute` context:

```ts
const bg = createBackgroundTasks({ emit });   // emit === the run-level queue emit
```

Two injection points, both mirroring the existing steer/followUp code exactly.

### (a) Turn top — deliver completed notifications

Immediately after the existing `takeSteers()` block at the top of the turn loop:

```ts
for (const c of bg.takeCompleted()) {
  const note = backgroundNote(c);            // see Notification format
  ctx.messages.push(note);
  await append({ type: "user", message: note });
  yield { type: "background_completed", completion: c };
}
```

This handles the common case where a task finishes while the model is busy with other (foreground) work: the notification is picked up on the next turn naturally. It reuses the exact injection pattern already used for steers (push to `ctx.messages` + persist as a `user` event), including the already-accepted "two consecutive user messages" shape (steers already produce this after a tool_result user message).

### (b) Model dry-out — join instead of stopping

In the `calls.length === 0` branch, **after** the existing `followUps` handling and before the final `stop`:

```ts
if (bg.pending() > 0 || bg.hasCompleted()) {
  yield { type: "turn_end", turn, stopReason: "stop" };
  if (!bg.hasCompleted()) await bg.waitNext(signal);   // block until next completion or abort
  continue;                                            // back to turn top → (a) injects → model consumes
}
// otherwise: the existing real stop
```

### maxTurns exemption (decided)

The `continue` above increments `turn`, so naively each background completion would consume one `maxTurns` budget slot. These join iterations are **not** model-driven loops — they are the kernel waiting on external work — so they are **exempt from `maxTurns`**. Implementation: the dry-out join branch decrements the turn counter (or counts join iterations separately) so waiting for background completions never exhausts the conversation-turn budget. (The turns the model spends *consuming* an injected notification are ordinary turns and do count.)

### Abort

On run abort, `bg.cancelAll()` is called from the loop-top `signal.aborted` check. `bg.cancelAll()` also runs unconditionally **after** the turn loop, which covers the `max_turns` exit — otherwise a task still pending at the turn cap would leak a detached child process / kernel. Because the kernel breaks out of the loop immediately on abort (and returns immediately on `max_turns`), cancelled tasks settle **asynchronously** and their completions are **not** drained/injected — so, exactly like the crash case below, an aborted or turn-capped run may leave a placeholder `tool_result` in the transcript with no following notification. That is accepted (the run is terminating). A normal `stop` exit is different: the join drains every completion first, so it never leaves a dangling placeholder.

## New event

`AgentEvent` (in `events.ts`) gains one additive, observational variant:

```ts
| { type: "background_completed"; completion: BackgroundCompletion }
```

Optionally a `background_started` too, but the `tool_use` + placeholder `tool_result` pair already marks a spawn, so `background_started` is omitted to keep the surface minimal (YAGNI). Consumers that ignore `background_completed` are unaffected.

## Tool-side policy (sdk)

### Schema fields

- `bashTool`: add `run_in_background: z.boolean().optional().default(false)` — foreground default.
- `agentTool`: add `run_in_background: z.boolean().optional().default(true)` — **background default**.

### Top-level switch

`createLiteAgent({ background?: boolean })` (and `query`) default `true`. When `false`, the kernel does not construct a registry, `ctx.background` is `undefined`, and both tools take their original synchronous path (the `run_in_background` field is ignored). This guarantees a clean regression story: with the feature off, the event stream is byte-for-byte what it is today.

### Placeholder results (returned immediately, seen by the model in-turn)

```
[background:bg_a1b2c3] started: npm test. Output will be delivered when it completes.
[background:bg_a1b2c3] dispatched 3 subagent(s). Aggregated results will be delivered when all complete.
```

### Notification format (injected user message on completion)

```
<background-task-completed id="bg_a1b2c3" label="npm test">
…real output / aggregated subagent[0..n] results…
</background-task-completed>
```

On error, add `status="error"`. The XML-ish tag lets the model reliably recognize this as an asynchronous result flowing back in, distinct from fresh user input.

### bash adaptation

When `run_in_background` is true and `ctx.background` exists: wrap the existing command execution in `ctx.background.spawn({ label: <command>, run: (signal) => <exec> })` and return the placeholder. Otherwise unchanged. (Note: background bash uses the task signal so `KillBackground` / run-abort can interrupt it; the existing sandbox wrapping still applies inside `run`.)

### Agent (subagent) adaptation

When `run_in_background` is true (the default) and `ctx.background` exists: wrap the whole batch in **one** `ctx.background.spawn`, whose `run` callback reuses the current `p-limit` fan-out over `tasks` (`runOne`) and returns the existing aggregated string (`subagent[0]…subagent[n]`). Child events forward through the spawn-provided run-level `emit` (stamped with `agentId` as today) instead of the per-turn `ctx.emit`. One batch → one notification. When `false`, the Agent tool runs its current fully-synchronous path unchanged.

The subagent *dispatch* logic stays entirely in the sdk `Agent` tool; core never learns what a subagent is.

## Cancel tool (sdk)

New tool `KillBackground({ id: string })` → `ctx.background.cancel(id)`, returning `Cancelled bg_a1b2c3` or `No running background task with id 'bg_…'`. Registered only when `background` is enabled. This is the safety valve for a hung background task under run-内 join (a stuck task would otherwise keep `run()` alive); combined with whole-run abort (which cancels all), it is the only management surface — no poll/peek tool (YAGNI: completions notify automatically).

## Persistence & edge cases (checkpointer)

- The placeholder is an ordinary `tool_result` event → persisted normally. The completion notification is a `user` message event → persisted like a steer. Because of run-内 join, a normal `stop` return never leaves a dangling placeholder (the join drains all completions first). A `max_turns` or aborted exit cancels pending tasks without draining, so — like a crash — it can leave a placeholder with no following notification.
- **Not persisted across restarts:** a background task's promise does not survive a process crash — matching Claude Code (background bash is not durable). The only resulting edge case is a crash mid-run leaving a persisted placeholder with no following completion; on resume the model sees an unresolved placeholder. Accepted.

## Testing strategy

Golden event-stream tests with the existing `fakeProvider`:

- Script the provider to emit one background tool call, then a dry-out turn (no tool calls); assert the stream shows `background_completed`, an injected `<background-task-completed>` user message, and that `done` is not emitted until the task actually completes.
- `BackgroundTasks` unit tests: spawn/pending/hasCompleted/takeCompleted/waitNext ordering, `cancel`, `cancelAll`, and abort-awareness of `waitNext`.
- Agent background batch: three child tasks collapse into one aggregated notification.
- maxTurns exemption: a run with a slow background task and a low `maxTurns` still joins to completion without hitting the turn cap.
- Switch off (`background: false`): both tools run synchronously; assert the event stream equals today's (regression guard).

## Non-Goals (YAGNI)

- Cross-run / detached background tasks that outlive the `run()` that spawned them.
- Persistence of background work across process restarts.
- A `BashOutput`-style tool to poll partial output of a running task.
- Real-time (sub-turn-boundary) streaming of background-task events; they surface at turn-boundary `drain()`, which is sufficient for observational logging/UI.
- `background_started` event (the `tool_use` + placeholder `tool_result` already mark the spawn).
