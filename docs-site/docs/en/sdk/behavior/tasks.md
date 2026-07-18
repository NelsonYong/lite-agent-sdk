# Tasks

Multi-step work needs a plan the model can see and update — and that survives context compaction and restarts. The Tasks capability gives the agent a **persistent task list** modeled on Claude Code's Tasks API: four built-in tools (`TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`), on-disk storage shared across sessions of the same project, and a per-turn reminder that keeps the current list in front of the model without polluting the transcript.

## Usage

Tasks are on by default — nothing to configure. The default [system prompt](/sdk/behavior/system-prompt) already teaches the model the workflow: call `TaskCreate` to capture each step of any 3+ step task, set it `in_progress` before starting, and `completed` only when fully done.

To scope a run to a named list, or turn the capability off:

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  taskListId: "release-0.4", // which list to use; default "default"
  // tasks: false,           // disable the tools and the reminder entirely
});
```

`query()` accepts the same `tasks` / `taskListId` options. The list can also be selected with the `$LITE_AGENT_TASK_LIST_ID` environment variable (precedence: `taskListId` > env > `"default"`).

## The tools

| Tool | What it does |
| --- | --- |
| `TaskCreate` | Create a task with an imperative `subject` and detailed `description` (optional `activeForm`, `metadata`). Returns the new task id. |
| `TaskUpdate` | Set `status` (`pending` / `in_progress` / `completed`), edit fields, set `owner`, or wire dependencies via `addBlockedBy` / `addBlocks`. An update that would create a dependency **cycle is rejected**. |
| `TaskGet` | Fetch one task's full detail by id (description, status, dependency edges). |
| `TaskList` | List every task with its status and `blockedBy` dependencies. |

## How it works

- **Persistence** — each task is a JSON file under `~/.lite-agent/projects/<hash>/tasks/<listId>/` (written atomically, guarded by a file lock). The list survives compaction and process restarts, and is **shared across sessions of the same project — including [subagents](/sdk/tools/subagents)**, so a parent and its children coordinate on one list.
- **Per-turn reminder** — a middleware re-injects the rendered list as a trailing `<system-reminder>` into the model request each turn, just before encoding. The reminder is never appended to the transcript or persisted, so the event log stays clean and the model always sees the latest state.
- **Dependencies** — `blockedBy` / `blocks` edges are maintained symmetrically by `TaskUpdate`, and a DFS cycle check rejects any update that would deadlock the graph.

## Disabling

Set `tasks: false` to remove all four tools **and** the reminder middleware:

```ts
const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  tasks: false,
});
```

## See also

- [System prompt](/sdk/behavior/system-prompt) — the task-planning instructions in the default prompt.
- [Subagents](/sdk/tools/subagents) — children share the project's task list.
- [Sessions](/sdk/core-concepts/sessions) — persistence and compaction the task list survives.
- [Getting started](/sdk/getting-started) — install and run your first agent.
