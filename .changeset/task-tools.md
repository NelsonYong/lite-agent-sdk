---
"@lite-agent/core": minor
"@lite-agent/provider": minor
"@lite-agent/sdk": minor
"@lite-agent/sandbox-anthropic": minor
---

Replace the in-memory `todo` tool with a persistent Tasks API (`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`): one JSON file per task under `tasks/<listId>/`, bidirectional dependencies with cycle detection, cross-process file locking, and a per-turn `<system-reminder>` that re-injects the current task list without persisting it. New `createLiteAgent`/`query` options `tasks` (default on) and `taskListId`.
