# Subagents

The `Agent` tool delegates large or context-heavy subtasks to subagents that run in **isolated sessions**: each child sees only the `prompt` you pass it (never the parent conversation) and returns only its final text. Isolation keeps the parent's context clean — you get the answer without paying for the exploration that produced it.

## Declaring a subagent

A subagent is an `agents/*.md` file with YAML frontmatter; the body becomes the subagent's system prompt:

```markdown
---
name: researcher
description: Research a topic and report findings with sources
tools: [read_file, bash]   # optional allow-list; absent = inherit the parent's tools
model: claude-haiku-4-5    # optional modelName override (same provider)
---

You are a research agent. Always cite your sources ...
```

**Loading order** (later directories override earlier ones by `name`):

1. Global: `~/.lite-agent/agents`
2. Project: `<workdir>/.lite-agent/agents`
3. `agentsDir` config option, if set

A built-in `general-purpose` agent (inherits the parent's full tool set and model) is always seeded, so subagents work with zero files. Set `agents: false` to disable the whole capability.

## Dispatch

One `Agent` call takes a batch of `tasks`; entries in a single call run in parallel (bounded concurrency), and each result block is labeled with an `agentId` that can be passed back as `resume` to continue that subagent later:

```json
{
  "tasks": [
    { "subagent_type": "researcher", "prompt": "Compare Rspress and VitePress" },
    { "subagent_type": "general-purpose", "prompt": "Audit deps for vulnerabilities" }
  ]
}
```

By default the call **blocks** until all children finish; `run_in_background: true` makes it fire-and-forget, with the aggregated results delivered later as a `<background-task-completed>` notification.

:::warning
Subagents run **without the parent's permission gate and `onApproval` handler** by default — an interactive approval handler cannot service parallel children. The sandbox still wraps every command. Pass `subagentPermission` (allow/deny rules, not `ask`) to gate subagent runs.
:::

## Programmatic access

Use `AgentLoader` / `builtinAgents` directly if you need the same loading mechanism outside `createLiteAgent`.

## See also

- [Built-in tools](/sdk/tools/builtin-tools) — the `Agent` tool and how to disable it (`agents: false`).
- [Skills](/sdk/tools/skills) — the other markdown-driven, on-demand capability.
- [Permissions](/sdk/control/permissions) — write the allow/deny rules `subagentPermission` expects.
- [Custom tools](/sdk/tools/custom-tools) — add tools your subagents can inherit.
