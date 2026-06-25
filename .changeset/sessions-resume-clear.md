---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
"@lite-agent/provider": minor
"@lite-agent/sandbox-anthropic": minor
---

feat: session management. `createLiteAgent` now returns a stateful `LiteAgent` that owns a current session and exposes `sessionId`, `resume(id)`, `clear()`, `deleteSession(id)`, and `listSessions()`. `jsonlStore` gains `list()`/`delete()` and is typed `SessionStore`; new `newSessionId`/`isSessionStore` helpers. The default session id is now a unique value instead of a process-local counter — fixing a cross-restart bug where a fresh run silently resumed (and kept growing) the previous run's `s1` transcript. The example CLI switches to server-side history and adds `/sessions`, `/resume`, `/clear`, `/delete`.
