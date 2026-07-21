# Background lifecycle

`createBackgroundTasks()` is the Core lifecycle primitive for finite joinable
work and detached work. SDK subagent groups use it as detached, session-owned
handles; Core itself does not define subagent scheduling or UI semantics.

## Structured result and status

A background `run` may return the legacy `string` result or a structured
`BackgroundRunResult`:

```ts
type BackgroundStatus = "completed" | "partial" | "failed" | "cancelled";

type BackgroundRunResult = {
  content: string;
  status: BackgroundStatus;
};
```

A string remains compatible and is treated as `{ content, status: "completed" }`.
Use a structured result whenever a task has its own aggregate lifecycle, such
as a subagent group with mixed child outcomes.

Each completion is a structured `BackgroundCompletion`:

```ts
type BackgroundCompletion = {
  id: string;
  label: string;
  content: string;
  status: BackgroundStatus;
  isError: boolean;
};
```

`status` is authoritative. `isError` remains for compatibility and is derived:
it is `false` only for `completed`, and `true` for `partial`, `failed`, and
`cancelled`. A `done` event describes a model turn ending, not success of a
background task; consumers should inspect
`background_completed.completion.status`.

## Model notification mapping

`backgroundCompletionMessage()` turns a completion into a user message for the
next model turn. The XML status attribute preserves the established successful
format and maps non-success states as follows:

| `BackgroundCompletion.status` | XML attribute |
| --- | --- |
| `completed` | omitted |
| `partial` | `status="partial"` |
| `failed` | `status="error"` |
| `cancelled` | `status="cancelled"` |

```xml
<background-task-completed id="bg_…" label="Subagent group: API review" status="partial">
## API review (agentId: agent-reviewer-…; status: completed)
…result…

## Security review (agentId: agent-general-purpose-…; status: failed)
Error: Subagent reached max turns
</background-task-completed>
```

The label is display text, while the id is the handle for cancellation or
tracking. Core does not infer success from content: callers must set the
structured status when they aggregate child work.

## Kinds and delivery

`kind: "joinable"` is the default for finite low-level work: the kernel waits
at dry-out and injects completed notifications. `kind: "detached"` never gates
run termination and supports `read()` for incremental output. Registries also
offer `cancel()`, `cancelAll()`, completion collection, and configurable
limits. A session owner can provide an externally owned registry to deliver
detached completions on later turns.

## See also

- [SDK background tasks](/sdk/control/background) — session ownership and interactive use.
- [Subagents](/sdk/tools/subagents) — pooled detached group semantics.
