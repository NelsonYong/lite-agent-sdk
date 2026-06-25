---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
"@lite-agent/provider": minor
"@lite-agent/sandbox-anthropic": minor
---

feat(sdk): subagents — a single parallel-capable `Agent` tool the main agent uses to delegate work (pass multiple `tasks` to fan out, bounded concurrency). A built-in `general-purpose` subagent is always available, so delegation works **out of the box with no configuration**; additional specialized agents load from `agents/*.md` (global `~/.lite-agent/agents` + project `<workdir>/.lite-agent/agents`) and a file named `general-purpose` overrides the built-in. Each subagent runs in an isolated, persisted (`agent-<id>.jsonl`), resumable session, shares the project task list, and runs under a lenient permission posture by default (the OS sandbox still applies). New `createLiteAgent`/`query` options `agents` (default on), `agentsDir`, and `subagentPermission`.
