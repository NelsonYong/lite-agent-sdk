# Hooks

Use `agent.hook(name, handler, options?)` for awaited lifecycle work. Each registration is independent, including multiple registrations of the same function. The return value unregisters only that registration.

```ts
const agent = createLiteAgent({ model, workdir });
const removeAudit = agent.hook("run:end", async ({ status, result, runId }, { signal }) => {
  await saveAudit({ runId, status, text: result?.text }, { signal });
});
agent.hook("run:end", async ({ status }) => {
  console.log(status);
});
removeAudit();
```

## Events

| Event | Payload in addition to identity |
| --- | --- |
| `run:start` | `input` |
| `run:end` | `status`, optional `result` and `error` |
| `tool:start` | `call` |
| `tool:end` | `call`, `status`, optional `result`/`error`, `durationMs` |
| `compact:start` | `compactionId`, `kind`, `before`, optional manual `instructions` |
| `compact:end` | `compactionId`, `kind`, `before`, `after`, `status`, optional `error` |

Identity includes `event`, `runId`, `sessionId`, `source` (`user`, `background`, `manual`) and optional `agentId` (absent for the root). Root registrations also apply to children; child and background runs receive their own run IDs. `run:end` means one run ended, not that every detached job has finished. Run results include text, usage, stop reason and optional structured output, not the full transcript.

Status is `completed`, `failed`, `cancelled`, or `max_turns`. Tool denial is a failed tool result. `tool:start` observes an attempted call, including attempts later denied by policy. `tool:end` runs after the tool/middleware returns and before the kernel persists/externalizes that result. A callback cannot change execution arguments or results: it receives a frozen copy, and return values are ignored.

Callbacks for one event run sequentially in registration order. Different tools or children can still execute concurrently. A dispatch snapshots its registrations, so changes during a callback affect subsequent dispatches. Hook work is awaited before the run proceeds; use `subscribe()` for observational progress instead.

Failures produce a `diagnostic` event with `code: "hook_failed"`; remaining callbacks still run. They do not turn a successful tool into a failure or trigger tool retries. Hooks are not permission gates or durable exactly-once jobs. Use run/call/compaction IDs as idempotency keys for external effects.

Default timeout is 10 seconds per handler, configurable with `{ timeoutMs }` from 1 to 120000 milliseconds. Handlers receive an AbortSignal as the second argument. End handlers also run after failure/cancellation, with a separate bounded cleanup signal. Trusted JavaScript callbacks must cooperate with cancellation; the SDK cannot forcibly stop arbitrary in-process code.

Do not await `run`, `send`, `awaitIdle`, `compact`, `restore`, `deleteSession`, or `close` on the same agent family inside a hook. This would wait on the operation currently executing the hook and is rejected explicitly. Schedule follow-up work after the callback has returned. `close()` waits for terminal callbacks and clears root registrations; registrations after close are rejected.

## Global and project hooks.json

Both files are discovered once when the root agent is created:

1. `<home>/hooks.json`, normally `~/.lite-agent/hooks.json` (`home` or `LITE_AGENT_HOME` overrides it).
2. `<workdir>/.lite-agent/hooks.json`.

Global arrays run first, then project arrays, then programmatic registrations. A project cannot overwrite global registrations. Identical physical files are loaded once. Executable configuration is not hot-reloaded; create a new agent after editing it. Invalid files fail at startup. Set `hookFiles: false` to disable file discovery while retaining `agent.hook()`.

```json
{
  "version": 1,
  "hooks": {
    "tool:end": [
      { "match": "write_file", "command": "node scripts/record-change.mjs", "timeoutMs": 10000 },
      { "match": "write_file", "command": "node scripts/update-index.mjs" }
    ],
    "run:end": [
      { "command": "node scripts/record-run.mjs" }
    ]
  }
}
```

Use arrays, not duplicate JSON keys. `match` is an optional tool-name glob and is only accepted on tool events. Commands run with `cwd = workdir`; one JSON event is delivered through stdin. Event data is never interpolated into the command. Stdout is not fed to the model and cannot control the agent; nonzero exit, timeout and excessive output are diagnostics. Input is capped at 256 KiB and combined stdout/stderr at 64 KiB.

## Command permissions

File commands use the **`hook` permission capability**, independent of `bash`. The SDK default asks for approval; without a handler it denies execution. Strict local mode denies by default. To authorize selected commands explicitly:

```ts
permission: policy({
  default: "deny",
  allow: ["read_file", "context"],
  rules: [{
    tool: "hook",
    when: {
      event: { equals: "run:end" },
      source: { equals: "project" },
      command: { equals: "node scripts/record-run.mjs" },
    },
    effect: "allow",
  }],
}),
```

The permission input includes `command`, `event`, `source` and `configFile`. A custom policy replaces SDK defaults, so review any allow-by-default policy when enabling file hooks. Hook commands always enforce their policy, even if model tools use permission dry-run. They reuse the configured sandbox and resource limits. Without a sandbox, an approved command runs on the host. Only PATH/HOME/TMPDIR/LANG/LC_ALL/TERM are inherited by default; an explicit `bash.env` is host-controlled. Permission auditing also records hook command decisions.

Programmatic callbacks are trusted host code, not sandboxed commands. Configure command permissions and sandboxing on `createLiteAgent()`. `query()` loads file hooks; use `createLiteAgent()` when you need to register callbacks in code.
