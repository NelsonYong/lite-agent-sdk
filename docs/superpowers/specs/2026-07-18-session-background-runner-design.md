# Session-Scoped Background Runner Design

## Status

Approved in conversation on 2026-07-18. Implementation in progress.

## Context

The current background implementation is scoped to one `runKernel()` call.
`Agent({ run_in_background: true })` creates a `joinable` task, so when the
model produces no more tool calls the kernel waits for the task, injects its
completion, and only then returns. Detached Bash tasks do not join, but the
kernel cancels them when that `run()` ends. Both behaviors prevent an SDK
consumer from returning to an idle prompt while background work continues.

This differs from the interaction model required here and from Claude Code's
interactive behavior. A background tool call must return a task handle
immediately. The main session then becomes idle and can accept another user
message. When the task completes, the runtime injects a synthetic notification
into the same session and schedules another assistant turn.

## Goals

- Keep ordinary `Agent` calls blocking by default.
- Make every explicitly backgrounded operation non-blocking, including
  `Agent({ run_in_background: true })` and `bash({ run_in_background: true })`.
- Allow background work to outlive the `run()` that spawned it, while remaining
  bound to its originating `LiteAgent` session.
- Allow new user input while background work is pending.
- Automatically wake the originating session when background work completes.
- Serialize user turns and background-completion turns within one session.
- Preserve the existing `run()` and `send()` APIs for one-shot consumers.
- Provide a long-lived event surface for interactive consumers that need to
  observe autonomous background wake-ups.
- Preserve default session persistence and inject completion notifications into
  the ordinary conversation transcript.

## Non-goals

- Resuming an in-flight Promise, child kernel, or child process after the SDK
  process restarts.
- Distributed workers, remote queues, leases, retries, or daemon supervision.
- Running two model turns concurrently against the same session.
- Changing the default `Agent` policy to background execution. Unlike current
  Claude Code, this SDK keeps `run_in_background: false` as the default.
- Making the low-level `@lite-agent/core` `createAgent()` facade stateful across
  independent agent instances.
- Persisting incremental Bash output. It remains an in-memory bounded buffer,
  but becomes readable across turns of the same live `LiteAgent` instance.

## Approaches considered

### 1. Keep the current run-level join

The current generator waits for joinable tasks and injects their results before
returning. This preserves a single event stream, but it necessarily blocks the
consumer's prompt and cannot satisfy idle-time user input. Rejected.

### 2. Return immediately and inject only on the next user `run()`

This is the smallest lifecycle change: keep a pending-completion list and drain
it when the user next calls `run()` or `send()`. It avoids blocking, but a
completed background task cannot wake an idle session on its own. It also makes
completion latency depend on unrelated user input. Rejected.

### 3. Session runner with a shared background manager and event subscription

Move background ownership from `runKernel()` to the stateful `LiteAgent`
facade. A per-session runner serializes user inputs and synthetic completion
inputs. Background completion schedules work on the same runner, and a
long-lived subscription exposes events produced after the spawning `run()` has
already returned. Chosen because it provides Claude Code-style idle/wake
semantics while preserving `run()` and `send()` as compatibility surfaces.

## Chosen architecture

```text
                         one LiteAgent instance

 user run/send ───────┐
                     v
              SessionRunner(sessionId) ───────> core.run(...)
                     ^                              |
                     |                              | tool ctx
 background finish ──┘                              v
              synthetic notification <── SessionBackgroundTasks
                     |
                     v
              session event publisher ───────> subscribers / UI
```

`runKernel()` remains a finite model/tool loop. It no longer owns the lifetime
of SDK background tasks. The `LiteAgent` facade owns one `SessionRunner` and one
`BackgroundTasks` registry per live session id.

### Session runner

The runner is a small scheduler with exactly one active core run per session.
It accepts two job types:

- **user job** — created by `run()` or `send()`;
- **completion job** — created when one or more background tasks finish.

Jobs execute serially in arrival order. If a completion arrives while a user
job is active, it waits until the user job finishes. If a user message arrives
while a completion job is active, it waits for that job. This avoids concurrent
checkpointer appends and guarantees a deterministic transcript.

When the runner is idle, a completion schedules a new core run immediately.
When another job is active, the completion always waits for that job to finish;
the active kernel never drains an externally owned completion queue. This gives
the queue one consumer and prevents duplicate injection without cross-run
coordination.

Multiple completions already available before a completion job starts are
batched into one core run. Each remains a separate
`<background-task-completed>` message and produces its own
`background_completed` event, but batching avoids one model call per task.

### Session-scoped background manager

The background registry moves from `runKernel()` construction to the
`LiteAgent` session runtime. A spawned task captures its originating
`sessionId`. Its lifecycle signal belongs to the session registry, not to the
parent `run()` signal.

Consequences:

- aborting or finishing the spawning `run()` does not cancel explicit
  background work;
- `KillBackground` still cancels one task by id;
- `BashOutput` can read output during later turns of the same live session;
- task limits continue to apply per session registry;
- deleting a session cancels that session's live tasks;
- closing the `LiteAgent` cancels every live task and closes its event stream.

`clear()` creates a new current session but does not silently cancel work owned
by the previous session. A completion always wakes its originating session and
the event envelope identifies that session. `resume(id)` selects the session
for subsequent user jobs without changing ownership of already-running work.

### Background kinds

The low-level distinction remains useful:

- `joinable` means finite work that intentionally gates a single low-level
  `runKernel()` call;
- `detached` means explicit background work whose lifetime is owned externally
  and never gates kernel dry-out.

The SDK `Agent` tool's default foreground path does not register a background
task; it continues to await `runBatch()` directly. With
`run_in_background: true`, its batch is registered as `detached`, just like
background Bash. `joinable` remains available to low-level callers that
intentionally want run-local join behavior. "Detached" here means detached
from one model run, not unowned: the session registry still tracks, limits,
notifies, and cancels it.

### Completion notification

The existing model-visible format is retained:

```xml
<background-task-completed id="bg_..." label="...">
...result...
</background-task-completed>
```

Successful completions keep the existing tag without a `status` attribute.
Failed completions add `status="error"`.

The runner passes these messages through the normal core input path. Therefore
the checkpointer persists them as ordinary user events and the context engine
sees them exactly like other dynamic transcript messages. The protected static
prompt prefix remains unchanged.

If the process exits before a task completes, the work is lost. If completion
has already been submitted to the runner and persisted, it survives restart as
ordinary session history.

## Public API

`run()` and `send()` retain their signatures and return when their own job
finishes. They do not wait for detached background tasks.

`LiteAgent` gains a long-lived observational subscription:

```ts
export interface LiteAgentEvent {
  sessionId: string;
  source: "user" | "background";
  event: AgentEvent;
}

export interface LiteAgent {
  // existing methods unchanged
  subscribe(listener: (entry: LiteAgentEvent) => void): () => void;
  close(): Promise<void>;
}
```

Every event from user jobs and completion jobs is published. A listener added
for an interactive UI can therefore render one continuous stream even after an
individual `run()` generator has returned. `run()` also continues to yield its
own user-job events for backward compatibility; consumers should avoid
rendering both surfaces simultaneously unless duplicate rendering is intended.

Listeners are observational: one listener throwing must not fail a run or
prevent delivery to other listeners. `close()` is idempotent. After close,
new runs fail with `AgentError` and no new listener events are published.

The package root exports `LiteAgentEvent`. The one-shot `query()` facade does
not expose cross-turn background semantics because it constructs and drains one
agent for one query. Explicit background tasks used through `query()` are
cancelled when that temporary agent is closed. Long-lived behavior belongs to
`createLiteAgent()`.

## Core integration

Core needs an injection seam for an externally owned `BackgroundTasks`
registry. The SDK passes the registry selected by `sessionId`; low-level
`createAgent()` without that seam keeps its existing per-run registry.

The kernel must distinguish registry ownership:

- an internally created registry is cancelled in `finally`, preserving current
  low-level cleanup;
- an externally supplied registry is never cancelled merely because one run
  ends;
- detached tasks never enter the dry-out join branch;
- finished external tasks are drained only through the session runner's
  completion scheduling protocol.

This seam is runtime infrastructure, not a new strategy role. Background work
remains a generic task primitive and the SDK tools retain policy decisions.

## Event and data flow

### Explicit background subagent

1. The model calls `Agent` with `run_in_background: true`.
2. The tool registers the batch in the session background manager and returns a
   `bg_...` placeholder immediately.
3. The current core run may continue other model/tool work, then returns without
   joining the batch.
4. The consumer can submit another user job while the subagent runs.
5. When the batch finishes, the manager records one completion and notifies the
   session runner.
6. The runner waits for any active job, drains available completions, and runs
   the core with their synthetic messages.
7. Events from this autonomous job are published with
   `source: "background"`.

### Background Bash

The flow is identical except output remains readable incrementally through
`BashOutput`. The command is not killed at the end of its spawning run. It ends
on normal process exit, `KillBackground`, configured timeout/limit, session
deletion, or `LiteAgent.close()`.

## Error handling

- A background task rejection becomes a completion with `status="error"` and
  wakes the session exactly like success.
- A model/provider failure during the autonomous completion job is published
  as the ordinary error event/result. The completion message has already gone
  through normal persistence, so a later user turn can still see it.
- Listener failures are isolated and ignored after best-effort delivery.
- A completion racing `close()` is settled at most once; close wins for any
  task that has not yet entered the completion queue.
- Session deletion cancels live work before deleting persisted history, so a
  late completion cannot recreate the deleted session.
- Concurrent public `run()`/`send()` calls for the same session are queued,
  not executed against the checkpointer concurrently.

## Compatibility

- `Agent` remains blocking by default.
- Foreground Bash and foreground subagents are unchanged.
- `run()`/`send()` source signatures remain compatible.
- Explicitly backgrounded subagents change from run-joinable to session-
  detached, which is the intended behavioral fix.
- Background Bash changes from "until this run ends" to "until session/agent
  close". Tool descriptions and changelogs must state this clearly.
- Consumers that only use `query()` retain finite one-shot behavior.
- Interactive consumers must subscribe once if they want to render autonomous
  completion turns after the original `run()` returns.

## Testing

### Core

- An externally owned detached registry is not cancelled at kernel run-end.
- An internally owned registry is still cancelled at run-end.
- Detached work never enters the join wait.
- Existing joinable behavior remains covered for low-level callers.

### SDK session runner

- Default `Agent` blocks and returns its aggregate inline.
- Background `Agent` returns a placeholder and the spawning `run()` completes
  before the child.
- A new user job completes while a background subagent is pending.
- An idle completion automatically starts a background-source turn.
- A completion arriving during a user job runs afterward, never concurrently.
- Multiple ready completions are batched without duplicate injection.
- Completion messages are persisted in the originating session.
- A task from session A still completes after `resume()` switches the current
  session to B, and its events remain attributed to A.
- Background Bash output remains readable from a later turn.
- `deleteSession()` cancels only that session's tasks.
- `close()` cancels all tasks, closes delivery, and is idempotent.
- Listener exceptions do not fail jobs or other listeners.
- Existing `run()` consumers still receive the events and result of their own
  user job.

### One-shot query

- `query()` still terminates and cleans up explicit background work instead of
  leaking a temporary agent.

## Documentation and release impact

Update the SDK README/API docs with one interactive example that subscribes
once, sends multiple user turns, and closes the agent on application shutdown.
Update the core and SDK changelogs and versions only after implementation is
verified, using the repository's package-scoped release process.
