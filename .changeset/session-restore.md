---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
"@lite-agent/checkpoint-sqlite": minor
---

Add session restore. A new `file_snapshot` sidecar event records the pre-mutation content of files changed via `write_file`/`edit_file`; `LiteAgent.restore(id, toSeq, { conversation?, files? })` rolls a session back to a checkpoint — reverting those files and/or truncating the conversation — and `listCheckpoints(id)` enumerates the rewind anchors. `Checkpointer` gains an optional `truncate`. Like Claude Code, files changed by `bash` are not tracked.
