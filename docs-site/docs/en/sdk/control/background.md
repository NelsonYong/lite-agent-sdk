# Background tasks

Long-running work doesn't have to block the agent. With `background: true` (the default), the agent can detach slow shell commands and subagent batches into background tasks, keep working in the foreground, and pick up the results when they land. You get incremental output polling, cancellation, and a `background_completed` event per finished task — all surfaced through the normal event stream.

## Use it

Nothing to configure — background tasks are on by default. The model opts in per call:

- **`bash` with `run_in_background: true`** runs detached — it returns a `bg_…` id immediately and never blocks the run's end. Poll incremental output with the `BashOutput` tool; the process is stopped automatically when the run ends.
- **`Agent` with `run_in_background: true`** (opt-in; blocking is the default) dispatches a subagent batch as one **joinable** task — the run stays alive until it finishes, and the aggregated result arrives as a `<background-task-completed>` notification.
- **`KillBackground`** cancels any running background task by id.

```xml
<background-task-completed id="bg_…" label="…">
…aggregated result…
</background-task-completed>
```

Detached vs. joinable: a **detached** task (background `bash`) is fire-and-forget — the run may end while it runs, and it is stopped at run end. A **joinable** task (background `Agent`) keeps the run alive until it completes, so its result is always delivered.

## The `background_completed` event

As each task finishes, a `background_completed` event is emitted into the run's event stream (and persisted into the session log like every other event):

```ts
for await (const ev of query({ /* … */ })) {
  if (ev.type === "background_completed") {
    console.log(ev.completion.id, ev.completion.content);
  }
}
```

This makes background completions visible to UIs and audit sinks — see [Observability](/sdk/control/observability).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `background` | `true` | Master switch. `false` disables the feature and removes the `BashOutput` / `KillBackground` tools. |
| `backgroundLimits` | — | Caps on background tasks (see below). |

`backgroundLimits` fields:

| Field | Description |
| --- | --- |
| `maxTotal` | Max background tasks overall. |
| `maxJoinable` | Max joinable tasks (background `Agent` batches). |
| `maxDetached` | Max detached tasks (background `bash`). |
| `bufferBytes` | Output ring-buffer size per detached task (default 1 MB, drop-oldest). |
| `maxTaskMs` | Max wall-clock lifetime of a background task. |

## Built-in tools

| Tool | Description |
| --- | --- |
| `BashOutput` | Read incremental output from a backgrounded `bash` command by its `bg_…` id. |
| `KillBackground` | Cancel a running background task by id. |

Both are registered only when `background` is enabled, and can be filtered like any other tool via `allowedTools` / `disallowedTools`.

## See also

- [Subagents](/sdk/tools/subagents) — the `Agent` tool and background dispatch.
- [Observability](/sdk/control/observability) — consuming `background_completed` events.
- [Checkpointing](/sdk/control/checkpointing) — background completions land in the session event log.
