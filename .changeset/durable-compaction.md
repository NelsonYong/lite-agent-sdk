---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

Add a manual, durable compaction action. `LiteAgent.compact()` compresses the current session's conversation using the configured compactor, persists the result as a new `summary` event (so it survives reloads and composes with restore), emits `compaction` progress + completion events, then stops — it never produces a model answer. `foldEvents` now treats `summary` as a base reset, so loading a compacted session uses the compressed view with no kernel change.
