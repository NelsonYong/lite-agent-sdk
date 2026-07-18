# Observability

Everything an agent does is already a typed stream of `AgentEvent`s — text deltas, tool calls, results, permission decisions, background completions. Observability means tapping that stream: feed it to your UI live, and/or persist it to a durable, hash-chained JSONL audit log with `jsonlEventSink` / `recordEventStream`. No separate tracing SDK needed.

## Record the event stream

Wrap any event stream with `recordEventStream` to tee every event into an `EventSink` while passing it through unchanged:

```ts
import { query, jsonlEventSink, recordEventStream } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

const sink = jsonlEventSink({ file: "./audit/events.jsonl" });

const stream = recordEventStream(
  query({
    prompt: "Summarize package.json",
    model: anthropic(),
    modelName: "claude-sonnet-4-6",
    cwd: process.cwd(),
  }),
  sink,
  "session-1",
);

for await (const ev of stream) {
  if (ev.type === "text_delta") process.stdout.write(ev.text); // live UI output
}
await sink.close();
```

The same loop is how you drive a UI: each `AgentEvent` is typed (`text_delta`, `tool_use`, `permission_decision`, `background_completed`, …), so renderers can switch on `ev.type`.

## `jsonlEventSink`

`jsonlEventSink(opts)` returns an `EventSink` that appends one JSON record per line:

```ts
export interface EventRecord {
  v: 1;
  ts: string;              // ISO timestamp
  sessionId: string;
  seq: number;             // per-file sequence
  prevHash: string | null; // hash of the previous record
  hash: string;            // sha256, or HMAC-sha256 with integrityKey
  event: AgentEvent;       // redacted before hashing
}
```

Records form a **hash chain** — each record commits to its predecessor, so a tampered or reordered log is detectable. Writes are serialized, and durable by default (append + `fsync` per record).

| Option | Default | Description |
| --- | --- | --- |
| `file` | — (required) | Path of the JSONL log file; parent directories are created automatically. |
| `maxBytes` | 10 MB | Rotate the file once it would exceed this size. |
| `maxFiles` | `5` | Rotated generations to keep (`file.1` … `file.N`). |
| `redactor` | `defaultRedactor` | Masks secrets in events before they are hashed and written. |
| `integrityKey` | — | Key for HMAC-sha256 record hashes instead of plain sha256. |
| `durable` | `true` | `false` skips the per-record `fsync` (faster, less crash-safe). |

Related types: `EventSink` (`write(sessionId, event)` / `close()`), `EventRecord`, `JsonlEventSinkOptions`.

## Permission audit events

Turn on `permissionAudit: true` and the gate appends a redacted `permission_decision` event to the **session event log** for every decision — including who made it (`policy` / `user` / `auto`). Because the audit trail lives in the same event stream, `recordEventStream` captures it alongside everything else; combine with `permissionMode: "dry-run"` to record what a candidate policy *would* deny without blocking anything. See [Permissions](/sdk/control/permissions).

## See also

- [Permissions](/sdk/control/permissions) — `permissionAudit`, dry-run, and redaction.
- [Checkpointing](/sdk/control/checkpointing) — the session event log itself.
- [Background tasks](/sdk/control/background) — the `background_completed` event.
- [Core strategies](/core/strategies) — where the `AgentEvent` types come from.
