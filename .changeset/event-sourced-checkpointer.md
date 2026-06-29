---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

Event-sourced checkpoint persistence

The session store is now an append-only, event-sourced `Checkpointer`: a per-session
log of `SessionEvent`s keyed by a monotonic `seq`, folded back into messages on load
(`foldEvents`). The kernel appends `user`/`assistant`/`tool_result` events as they
occur — each tool result is persisted the moment it completes, closing the mid-turn
data-loss window under concurrent tool execution. New API: `Checkpointer`,
`memoryCheckpointer`, `fileCheckpointer` (the new default), `legacyStoreAdapter`,
`foldEvents`, `CheckpointConflictError`, plus optimistic multi-client concurrency via
`expectedHead`. The legacy `Store` (`jsonlStore`/`memoryStore`) still works via
`legacyStoreAdapter`. Old whole-array transcripts are not migrated and are swept on
cleanup.
