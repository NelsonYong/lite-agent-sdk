# Background tasks

With `background: true` (the default), a long-lived `createLiteAgent()` owns
session-scoped background work. Subscribe once to observe ordinary user turns,
child events, and autonomous completion turns; call `close()` to cancel live
work and release the session runner.

```ts
const agent = createLiteAgent({ model, workdir: process.cwd() });
const unsubscribe = agent.subscribe(({ sessionId, source, event }) => {
  render(sessionId, source, event);
});

await agent.send("Delegate the review");
await agent.send("Answer another question while it runs");

unsubscribe();
await agent.close();
```

## Bash and Agent have different lifecycles

- **`bash` with `run_in_background: true`** starts a detached process and
  returns a `bg_…` id immediately. Use `BashOutput` to read incremental output
  and `KillBackground` to cancel it. This remains suitable for daemons.
- **`Agent`** always registers one detached subagent group. Its
  `run_in_background` input is accepted only as a compatibility adapter and
  cannot make the group synchronous. `background: false` instead rejects Agent
  dispatch explicitly.

An Agent group emits one aggregate `background_completed` event only after all
children settle. The owning session is then woken for one autonomous completion
turn; user turns and completion turns are serialized per session.

`query()` is deliberately finite: it waits for Agent groups it created and
their autonomous completion turns before closing its temporary agent. It does
not wait for unrelated detached Bash daemons. Choose `createLiteAgent()` for
work that must remain interactive after the initiating turn returns.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `background` | `true` | Master switch. `false` removes `BashOutput` / `KillBackground` and makes Agent dispatch fail. |
| `backgroundLimits` | — | Limits for session background handles and detached Bash output. |
| `maxParallelSubagents` | `5` | Shared FIFO limit for child kernels across every group on one root agent. |

`backgroundLimits` fields:

| Field | Description |
| --- | --- |
| `maxTotal` | Max background handles overall. |
| `maxJoinable` | Max low-level joinable handles. Agent groups are detached. |
| `maxDetached` | Max detached handles. |
| `bufferBytes` | Output ring-buffer size per detached task (default 1 MB, drop-oldest). |
| `maxTaskMs` | Max wall-clock lifetime of a background task. |

## Completion status

Inspect `event.completion.status` in `background_completed`; it is the
authoritative result. `completed` means every child succeeded. `partial` keeps
both successful output and unsuccessful diagnostics; `failed` and `cancelled`
are not successes. The compatibility `isError` field is derived as
`status !== "completed"`.

```ts
for await (const event of query({ /* … */ })) {
  if (event.type === "background_completed") {
    console.log(event.completion.status, event.completion.content);
  }
}
```

## Built-in controls

| Tool | Description |
| --- | --- |
| `BashOutput` | Read incremental output from a backgrounded `bash` command by its `bg_…` id. |
| `KillBackground` | Cancel a live background handle by id. |

Both are registered only when `background` is enabled and can be filtered with
`allowedTools` / `disallowedTools`.

## See also

- [Subagents](/sdk/tools/subagents) — task naming, group delivery, and pool semantics.
- [Core background lifecycle](/core/background) — statuses and XML notification mapping.
- [Observability](/sdk/control/observability) — consuming `background_completed` events.
