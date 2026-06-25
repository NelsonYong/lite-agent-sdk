---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
"@lite-agent/provider": minor
"@lite-agent/sandbox-anthropic": minor
---

feat(sdk): file-defined subagents loaded from `agents/*.md` (global `~/.lite-agent/agents` + project `<workdir>/.lite-agent/agents`), dispatched via a single parallel-capable `Agent` tool (pass multiple `tasks` to fan out, bounded concurrency). Each subagent runs in an isolated, persisted (`agent-<id>.jsonl`), resumable session, shares the project task list, and runs under a lenient permission posture by default (the OS sandbox still applies). New `createLiteAgent`/`query` options `agents` (default on), `agentsDir`, and `subagentPermission`.
