# @lite-agent/sdk

Batteries-included agent SDK over [`@lite-agent/core`](/packages/core): a working tool set, skills, subagents, sessions, and a permission gate behind a small [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)-shaped API (`query` / `createLiteAgent` / `tool`). Pair it with a [`@lite-agent/provider`](/packages/provider) for the model — every battery is a toggleable default over the core strategies.

## Install

```bash
pnpm add @lite-agent/sdk @lite-agent/provider zod
```

## Quick start

```ts
import { query, tool } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { z } from "zod";

const weather = tool(
  "get_weather",
  "Get the weather for a city",
  z.object({ city: z.string() }),
  async ({ city }) => `It's sunny in ${city}.`,
);

for await (const ev of query({
  prompt: "What's the weather in Tokyo?",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  tools: [weather],
  allowedTools: ["get_weather", "read_file"],
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

## `query` vs `createLiteAgent`

- **`query(opts)`** — one-shot run. Streams typed `AgentEvent`s and resolves to a `LiteAgentResult`. Use it for single prompts and scripts.
- **`createLiteAgent(cfg)`** — stateful, session-owning `LiteAgent` for multi-turn work: `send()`, `resume(id)`, `clear()`, `listSessions()`, `deleteSession(id)`, time travel via `listCheckpoints(id)` / `restore(id, seq)`, and manual `compact()`.

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
});

await agent.send("Refactor src/auth.ts to use async/await.");
const result = await agent.send("Now add tests for it."); // same session, full context
```

## Built-in tools

All built-ins are registered by default and can be filtered with `allowedTools` / `disallowedTools`.

| Tool | Description |
| --- | --- |
| `bash` | Run a shell command in the workspace (builds, tests, git, search). `run_in_background: true` detaches long-running commands. |
| `read_file` | Read a file's contents, with an optional line `limit` for large files. |
| `write_file` | Create or overwrite a file atomically; parent directories are created automatically. |
| `edit_file` | Replace the first exact occurrence of `old_text` with `new_text` in a file. |
| `delete_file` | Delete a file (snapshotted first, so `restore()` can recreate it). |
| `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` | Persistent task list for multi-step work (see [Tasks](#tasks)). |
| `Agent` | Delegate subtasks to subagents (see [Subagents](#subagents)). |
| `load_skill` | Load a skill's body into context on demand (see [Skills](#skills)). |
| `BashOutput` | Read incremental output from a backgrounded `bash` command by its `bg_…` id. |
| `KillBackground` | Cancel a running background task by id. |
| `ask_user` | Ask the user a question mid-run — registered only when `onAskUser` is set. |
| `final_answer` | Return the validated structured answer — registered only when `outputSchema` is set. |

The file tools are scoped to `workdir`, write atomically, and snapshot every file before changing it so session restore can undo the change.

## Skills

A skill is a directory containing a `SKILL.md` file — instructions the model loads on demand instead of paying for them in every prompt.

**Loading order** (later directories override earlier ones on name collision):

1. Global: `~/.lite-agent/skills`
2. Project: `<workdir>/.lite-agent/skills`
3. `skillsDir` config option, if set

The system prompt lists each skill's name and description; the model pulls in the full body with the `load_skill` tool when it decides the skill is relevant.

**`SKILL.md` format** — YAML frontmatter plus a Markdown body:

```markdown
---
name: pdf-tools          # optional; defaults to the directory name
description: Extract and merge PDF files  # surfaced in the system prompt
tags: [docs, pdf]        # optional, string or list
---

When the user asks to merge PDFs, run ...
```

Use `SkillLoader` / `loadSkillTool` directly if you need the same mechanism outside `createLiteAgent`.

## Subagents

The `Agent` tool delegates large or context-heavy subtasks to subagents that run in **isolated sessions**: each child sees only the `prompt` you pass it (never the parent conversation) and returns only its final text. Isolation keeps the parent's context clean.

**Declaring a subagent** — an `agents/*.md` file with YAML frontmatter; the body becomes the subagent's system prompt:

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

**Dispatch** — one `Agent` call takes a batch of `tasks`; entries in a single call run in parallel (bounded concurrency), and each result block is labeled with an `agentId` that can be passed back as `resume` to continue that subagent later:

```json
{
  "tasks": [
    { "subagent_type": "researcher", "prompt": "Compare Rspress and VitePress" },
    { "subagent_type": "general-purpose", "prompt": "Audit deps for vulnerabilities" }
  ]
}
```

By default the call **blocks** until all children finish; `run_in_background: true` makes it fire-and-forget, with the aggregated results delivered later as a notification.

:::warning
Subagents run **without the parent's permission gate and `onApproval` handler** by default — an interactive approval handler cannot service parallel children. The sandbox still wraps every command. Pass `subagentPermission` (allow/deny rules, not `ask`) to gate subagent runs.
:::

## Tasks

A persistent task list mirrors Claude Code's Tasks API: `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`. Each task is a JSON file under `~/.lite-agent/projects/<hash>/tasks/<listId>/`, so it survives compaction and restart, and is shared across sessions of the same project (including subagents). A per-turn middleware re-injects the current list into the model request as a `<system-reminder>` without persisting it.

- Tasks carry `subject`, `description`, `status` (`pending` / `in_progress` / `completed`), and auto-maintained `blockedBy` / `blocks` dependencies with cycle detection.
- `taskListId` (or `$LITE_AGENT_TASK_LIST_ID`) selects the list; `tasks: false` disables the tools and the reminder.

## Sessions

With the default `fileCheckpointer` (or any `Checkpointer`, e.g. [`@lite-agent/checkpoint-sqlite`](/packages/checkpoint-sqlite)), every run is event-sourced to disk, and `LiteAgent` owns a current session:

| Method | Description |
| --- | --- |
| `send(input, opts?)` | Run one turn to completion in the current session; resolves to `LiteAgentResult`. |
| `sessionId` | The id `run`/`send` use when `opts.sessionId` is not passed. |
| `resume(id)` | Switch the current session to an existing id (unknown ids start empty). |
| `clear()` | Rotate to a new empty session; returns the new id. The old transcript is kept. |
| `listSessions()` | List persisted sessions (`{ id, mtime }`, most-recent first). |
| `deleteSession(id)` | Delete a persisted session transcript. |
| `listCheckpoints(id)` | List rewind anchors (one per user prompt) for a session, oldest first. |
| `restore(id, seq, opts?)` | Roll a session back to just before a checkpoint: reverts snapshotted files (`files`, default `true`) and/or truncates the conversation (`conversation`, default `true`). Sets the current session to `id`. |
| `compact(instructions?)` | Manually compact the current session; streams progress events and resolves to `{ before, after }` token counts. |

```ts
const sessions = await agent.listSessions();
agent.resume(sessions[0].id);            // continue the most recent session

const checkpoints = await agent.listCheckpoints(agent.sessionId);
await agent.restore(agent.sessionId, checkpoints[2].seq); // undo everything after that prompt
```

Time travel works because file tools snapshot every file before modifying it: `restore` replays those snapshots to undo changes on disk, then truncates the event log. Set `sessions: false` to disable persistence entirely (session methods then reject).

## Permission gate

`policy()` matches tool calls against allow/ask/deny rule sets and decides what may run. Name matching uses globs, and precedence is always **deny > ask > allow** — a mis-ordered allow can never shadow a deny:

```ts
import { createLiteAgent, policy, bashCommand, filePath } from "@lite-agent/sdk";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  permission: policy({
    allow: ["read_file", "Task*"],
    ask: ["write_file", "edit_file"],
    deny: ["bash"],
  }),
  onApproval: {
    // human-in-the-loop: decide each "ask" call
    request: async (call) => (confirm(`Allow ${call.name}?`) ? "allow" : "deny"),
  },
  permissionAudit: true, // persist redacted decisions in the session event log
});
```

### Content-level rules

Beyond tool names, `policy({ rules })` matches on **call input** via a `when` spec (`glob` / `regex` / `startsWith` / `equals` / … over dot-paths like `command` or `path`). The sdk ships specifiers for its own tools:

```ts
permission: policy({
  rules: [
    bashCommand("rm -rf*", "deny"),        // block destructive shell commands
    bashCommand("git status*", "allow"),   // `:*` desugars to a prefix match
    filePath("src/**", "allow"),           // allow file tools under ./src
    filePath("**/.env*", "deny"),          // …but never touch env files
  ],
  default: "ask",
}),
```

:::tip
Bash command matching is best-effort — shell quoting and chaining can bypass prefix rules. The permission gate is defense-in-depth; the [sandbox](#sandbox) is the real containment.
:::

### Auditing and dry-run

- `permissionAudit: true` appends a redacted `permission_decision` event to the session log for every decision, including who made it (`policy` / `user` / `auto`). Secrets in tool input are masked by `defaultRedactor` (override with `redact`).
- `permissionMode: "dry-run"` computes and records verdicts **without blocking anything** — point a candidate policy at real traffic to see what it would deny before enforcing it.
- Policies compose deny-wins via `composePolicies(...)` (a managed layer downstream users cannot loosen), and `strictPolicy({ allow })` gives a deny-by-default posture.

## Sandbox

Pass a `Sandbox` (e.g. [`@lite-agent/sandbox-anthropic`](/packages/sandbox-anthropic)) to run every `bash` command inside an OS boundary (Seatbelt on macOS, bubblewrap on Linux):

```ts
import { sandboxRuntime } from "@lite-agent/sandbox-anthropic";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  sandbox: sandboxRuntime({ allowedDomains: ["api.github.com"] }),
});
```

The gate decides *whether* a command runs; the sandbox constrains *what it can touch* while running — they compose. See [`@lite-agent/sandbox-anthropic`](/packages/sandbox-anthropic) for the full adapter.

## Structured output

Set `outputSchema` (a Zod **object** schema) to force a validated final answer. A `final_answer` tool is registered with your schema as its parameters, the model is instructed to call it exactly once when done, and the validated arguments surface as `result.output`:

```ts
const result = await agent.send("Summarize package.json");

// with outputSchema: z.object({ name: z.string(), deps: z.number() })
result.output; // { name: "…", deps: 42 } — validated against the schema
```

`outputSchema` is not inherited by subagents.

## Background tasks

With `background: true` (the default), long-running work can leave the foreground:

- **`bash` with `run_in_background: true`** runs detached — it returns a `bg_…` id immediately and never blocks the run's end. Poll incremental output with `BashOutput`; the process is stopped automatically when the run ends.
- **`Agent` with `run_in_background: true`** (opt-in; blocking is the default) dispatches a subagent batch as one joinable task — the run stays alive until it finishes, and the aggregated result arrives as a `<background-task-completed>` notification.
- **`KillBackground`** cancels any running background task by id.

A `background_completed` event is emitted as each task finishes. `background: false` disables the feature and removes `BashOutput` / `KillBackground`.

## `createLiteAgent` configuration

| Option | Default | Description |
| --- | --- | --- |
| `model` | — | **Required.** A `ModelProvider` from [`@lite-agent/provider`](/packages/provider). |
| `modelName` | provider default | Model id forwarded to the provider. |
| `workdir` | — | **Required.** Workspace root; file tools are scoped to it. |
| `system` | built-in prompt | Override the system prompt. |
| `tools` | — | Extra tools (via `tool()`), appended after the built-ins. |
| `allowedTools` / `disallowedTools` | — | Filter the final tool set by name. |
| `maxTurns` | — | Cap conversation turns per run. |
| `maxTokens`, `temperature`, `topP`, `toolChoice`, `seed` | — | Sampling parameters forwarded to the provider. |
| `maxParallelTools` | `10` | Max concurrent tool calls per turn (`1` = sequential). |
| `outputSchema` | — | Zod object schema for a validated final answer. |
| `sandbox` | — | `Sandbox` strategy wrapping `bash` commands. |
| `permission` / `onApproval` | — | Permission policy + human-in-the-loop handler. |
| `permissionMode` | `"enforce"` | `"dry-run"` records decisions without blocking. |
| `permissionAudit` | `false` | Persist redacted permission decisions in the session log. |
| `redact` | `defaultRedactor` | Redactor for audit payloads. |
| `onAskUser` | — | Input handler; registers the `ask_user` tool. |
| `skillsDir` | — | Extra skills directory (overrides global + project). |
| `tasks` / `taskListId` | `true` / `"default"` | Persistent task tools + reminder; which list to use. |
| `agents` / `agentsDir` | `true` / — | Subagents and the `Agent` tool; extra agents directory. |
| `subagentPermission` | — | Permission policy applied to subagent runs. |
| `background` / `backgroundLimits` | `true` / — | Background tasks (`BashOutput` / `KillBackground`). |
| `sessions` | `true` | Persist sessions (ignored when `checkpointer`/`store` is set). |
| `checkpointer` / `store` | `fileCheckpointer` | Persistence backend. |
| `context` | engine defaults | Automatic context management (`{ windowTokens, planner }`; `false` to disable). |
| `home` | `$LITE_AGENT_HOME` \|\| `~/.lite-agent` | Global home directory. |
| `cleanup` | `true` (30 days) | Sweep stale spill/session files at startup. |
| `crashRecovery` | — | `"safe"` persists tool starts and closes interrupted calls on resume. |
| `use` | — | Extra middleware. |
| `codec` | `nativeCodec()` | Tool-call protocol. |
| `fileTools` / `bash` | — | Per-tool hardening options. |

`query(opts)` accepts the same options plus `prompt` (and `sessionId` to resume a specific session) — with two renames: `workdir` → `cwd` and `system` → `systemPrompt`.

## API reference

| Symbol | Description |
| --- | --- |
| `query(opts)` | One-shot agent run — `AsyncGenerator<AgentEvent, LiteAgentResult>`. |
| `createLiteAgent(cfg)` | Stateful, session-owning agent (`LiteAgent`). |
| `tool(name, description, schema, handler)` | Define a tool from a Zod schema. |
| `buildSystemPrompt(opts)` | The default system-prompt builder. |
| `defaultTools`, `bashTool`, `fileTools`, `taskTools`, `agentTool`, `askUserTool`, `bashOutputTool`, `killBackgroundTool` | Built-in tool sets, individually importable. |
| `policy`, `bashCommand`, `filePath`, `permissionFilePolicy` | Permission policies and content-level specifiers. |
| `fileCheckpointer`, `jsonlStore`, `fileTaskStore`, `fileSpillStore`, `fileContextArchive` | File-backed persistence adapters. |
| `jsonlEventSink`, `recordEventStream` | Event observability sinks. |
| `SkillLoader`, `loadSkillTool`, `AgentLoader`, `builtinAgents` | Skill and subagent loading. |
| `* from @lite-agent/core` | Full re-export of the kernel: types, events, strategies, middleware helpers. |

## See also

- [`@lite-agent/core`](/packages/core) — the provider-agnostic kernel this package assembles.
- [`@lite-agent/provider`](/packages/provider) — model providers (Anthropic, …).
- [`@lite-agent/checkpoint-sqlite`](/packages/checkpoint-sqlite) — SQLite session persistence.
- [`@lite-agent/sandbox-anthropic`](/packages/sandbox-anthropic) — OS-level sandbox adapter.
- [`@lite-agent/local`](/packages/local) — strict local-hardening defaults.
- [Getting started](/guide/getting-started) — install and run your first agent.
