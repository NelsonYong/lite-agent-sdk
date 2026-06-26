---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

feat: run a turn's tool calls concurrently (default-on; cap `maxParallelTools`, default 10)

The kernel now executes all tool calls of a single assistant turn in parallel,
bounded by `maxParallelTools` (default 10; set to 1 for the old sequential
behavior). Output stays deterministic — `tool_result` blocks and events flush in
input order regardless of completion timing — and the permission gate serializes
concurrent approval prompts so they never overlap. Multiple `Agent` (subagent)
calls in one turn now fan out simultaneously instead of running one after another.

Event-stream note: for multi-tool turns, all `tool_use` events are now emitted up
front (before any tool runs), rather than interleaved with each call's result.
