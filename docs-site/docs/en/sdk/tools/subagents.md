# Subagents

The `Agent` tool delegates large or context-heavy subtasks to subagents that run in **isolated sessions**: each child sees only the `prompt` you pass it (never the parent conversation) and returns only its final text. Isolation keeps the parent's context clean — you get the answer without paying for the exploration that produced it.

## Declaring a subagent

A subagent is an `agents/*.md` file with YAML frontmatter; the body becomes the subagent's system prompt:

```markdown
---
name: researcher
description: Research a topic and report findings with sources
tools: [read_file, bash]   # optional allow-list; absent = inherit the parent's tools
model: simple              # optional configured tier or raw model id override
---

You are a research agent. Always cite your sources ...
```

**Loading order** (later directories override earlier ones by `name`):

1. Global: `~/.lite-agent/agents`
2. Project: `<workdir>/.lite-agent/agents`
3. `agentsDir` config option, if set

A built-in `general-purpose` agent (inherits the parent's full tool set and model) is always seeded, so subagents work with zero files. Set `agents: false` to disable the whole capability.

## Model selection

With a `models` catalog, choose `simple`, `medium`, or `complex` in a
definition or in an individual task. Selection is deterministic:

```text
task.model -> subagent definition model -> current/default tier
```

For example, this `simple` definition is overridden by one `complex` task:

```json
{
  "tasks": [{
    "display_name": "Architecture review",
    "subagent_type": "researcher",
    "model": "complex",
    "prompt": "Compare the two cross-package designs"
  }]
}
```

Any model string other than the configured tier names remains a raw provider
model id for backward compatibility, using the inherited provider. Use
`simple` for known low-ambiguity work (a lookup or one small-file procedure),
`medium` for ordinary multi-file work in one package, bug fixes, and tests, and
`complex` for cross-package architecture, concurrency/persistence, external
research, repeated failures, or high uncertainty.

Tiers only select a provider/model pair. They do not change permissions,
approval, reasoning effort, budgets, or concurrency. The SDK does not yet
classify tasks automatically, escalate after failures, or retry on another
tier; the parent chooses the tier explicitly.

## Dispatch

Every `Agent` call creates one sibling **group**. Each task must include a
non-empty, visible `display_name`: it is the UI and result label for this
invocation. `subagent_type` only selects an `AgentLoader` definition, while
the returned `agentId` is the stable run identity to pass as `resume` later.

Groups are always detached from a long-lived `createLiteAgent()` session. The
tool immediately returns an accepted-group placeholder; after **all** children
settle, the session receives exactly one ordered aggregate completion. The
legacy `run_in_background` field is still accepted for parsing, but no longer
changes this behavior; `run_in_background: false` does not make a group
synchronous. Set `background: false` only when you want Agent dispatch to fail
explicitly instead of creating background work.

The root agent owns one shared FIFO pool. `maxParallelSubagents` defaults to 5
and is shared by groups from every session on that root, so two groups with
three tasks each never get separate five-child limits. Results retain task
input order. A group is `completed` only when all children complete; mixed
outcomes are `partial`; wholly failed or cancelled groups are respectively
`failed` or `cancelled`. A child that throws, is cancelled, reaches
`max_turns`, or stops without final text is never represented as success.

For example, two calls can submit two groups of three tasks:

```json
{
  "tasks": [
    { "display_name": "Architecture research", "subagent_type": "researcher", "prompt": "Compare Rspress and VitePress" },
    { "display_name": "Dependency audit", "subagent_type": "general-purpose", "prompt": "Audit dependencies for vulnerabilities" },
    { "display_name": "Test plan", "subagent_type": "general-purpose", "prompt": "Draft regression tests" }
  ]
}
```

```json
{
  "tasks": [
    { "display_name": "API review", "subagent_type": "reviewer", "prompt": "Review the public API" },
    { "display_name": "Docs review", "subagent_type": "writer", "prompt": "Find migration gaps" },
    { "display_name": "Security review", "subagent_type": "general-purpose", "prompt": "Review security assumptions" }
  ]
}
```

One mixed aggregate is delivered after its group settles:

```xml
<background-task-completed id="bg_…" label="Subagent group: Architecture research, Dependency audit, Test plan" status="partial">
## Architecture research (agentId: agent-researcher-…; status: completed)
…final text…

## Dependency audit (agentId: agent-general-purpose-…; status: failed)
Error: Subagent reached max turns
</background-task-completed>
```

Use `createLiteAgent()` with `subscribe()` and `close()` for interactive,
long-lived work: user and autonomous completion turns are serialized per
session, while subscription receives child and aggregate events. `query()` is
one-shot: before it closes its temporary agent it waits for Agent groups it
started and their autonomous completion turns, but it does not wait for an
unrelated detached daemon such as background Bash.

Children run with `agents: false`; recursive subagents, Agent Teams, message
buses, shared inboxes, and task claiming are not supported.

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
