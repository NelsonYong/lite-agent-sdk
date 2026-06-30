# @lite-agent/checkpoint-sqlite

## 0.7.0

### Minor Changes

- 795c10d: Add session restore. A new `file_snapshot` sidecar event records the pre-mutation content of files changed via `write_file`/`edit_file`; `LiteAgent.restore(id, toSeq, { conversation?, files? })` rolls a session back to a checkpoint — reverting those files and/or truncating the conversation — and `listCheckpoints(id)` enumerates the rewind anchors. `Checkpointer` gains an optional `truncate`. Like Claude Code, files changed by `bash` are not tracked.

### Patch Changes

- Updated dependencies [2d0e4b9]
- Updated dependencies [795c10d]
  - @lite-agent/core@0.7.0

## 0.6.2

### Patch Changes

- Updated dependencies
  - @lite-agent/core@0.5.1

## 0.5.0

### Minor Changes

- 780242e: New package: a SQLite (WAL) Checkpointer backend for single-host multi-process persistence. `sqliteCheckpointer({ file })` passes the shared checkpointer conformance suite.

### Patch Changes

- Updated dependencies [c695991]
- Updated dependencies [fefb68f]
- Updated dependencies [c99328b]
  - @lite-agent/core@0.5.0
