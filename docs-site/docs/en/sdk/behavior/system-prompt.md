# System prompt

Every lite-agent run starts from a system prompt that grounds the model in your workspace: where it may work, which tools to prefer, and which skills and subagents exist. The SDK builds a good one for you with `buildSystemPrompt` — workdir, model name, available skills, and available subagents are all filled in automatically — and lets you replace or extend it when your agent needs its own voice, rules, or domain context.

## Usage

Pass `system` to `createLiteAgent` (or `systemPrompt` to `query`) to **replace** the built-in prompt entirely:

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  system: "You are a release-notes assistant. Answer concisely, in Markdown.",
});
```

`query()` accepts the same string under the name `systemPrompt`:

```ts
import { query } from "@lite-agent/sdk";

for await (const ev of query({
  prompt: "Draft release notes for v0.4.0.",
  model: anthropic(),
  cwd: process.cwd(),
  systemPrompt: "You are a release-notes assistant. Answer concisely, in Markdown.",
})) {
  // ...
}
```

## Appending to the default prompt

A full override throws away the built-in grounding. To **keep the default and add your own rules**, call `buildSystemPrompt` yourself and concatenate — it is the same builder the SDK uses internally, exported from `@lite-agent/sdk`:

```ts
import { createLiteAgent, buildSystemPrompt } from "@lite-agent/sdk";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  system:
    buildSystemPrompt({ workdir: process.cwd(), skills: "" }) +
    "\n\n## House rules\n- Never commit directly to main.\n- Run pnpm test before finishing.",
});
```

`buildSystemPrompt(opts)` takes a `SystemPromptOptions` object and returns the prompt string:

| Option | Type | Description |
| --- | --- | --- |
| `workdir` | `string` | **Required.** Baked into the prompt as the workspace boundary. |
| `modelName` | `string` | Optional; adds a `Your model is …` line. |
| `skills` | `string` | Pre-rendered list of available skills, shown under the Skills section. |
| `subagents` | `string` | Optional pre-rendered list of available subagents; adds a Subagents section. |

:::warning
When you override `system`, the SDK no longer injects the auto-generated lists of available skills and subagents into the prompt. The `load_skill` and `Agent` tools still work, but the model only knows what to load if your prompt tells it.
:::

## What the default prompt contains

`buildSystemPrompt` produces a compact prompt with these sections:

- **Identity & boundary** — "You are lite-agent, a coding agent operating in `<workdir>`"; never access paths outside it.
- **Core principles** — prefer tools over prose.
- **Files** — use `read_file` / `write_file` / `edit_file` / `delete_file` instead of shell equivalents; use `bash` for running commands and searching.
- **Task planning** — for 3+ step work, plan with `TaskCreate` and track with `TaskUpdate` (see [Tasks](/sdk/behavior/tasks)).
- **Skills** — pull specialized knowledge on demand with `load_skill`, followed by the auto-discovered skill list.
- **Subagents** — when subagents exist, how and when to delegate with the `Agent` tool (see [Subagents](/sdk/tools/subagents)).

Two capabilities extend the prompt at assembly time rather than through `system`:

- Setting [`outputSchema`](/sdk/behavior/structured-output) appends a `## Final answer` section instructing the model to call `final_answer` exactly once.
- The [Tasks](/sdk/behavior/tasks) reminder is injected per turn as a `<system-reminder>` message, not into the system prompt.

## See also

- [Structured output](/sdk/behavior/structured-output) — the `## Final answer` section appended when `outputSchema` is set.
- [Tasks](/sdk/behavior/tasks) — the per-turn task-list reminder.
- [Subagents](/sdk/tools/subagents) — the subagent list the default prompt surfaces.
- [Getting started](/sdk/getting-started) — install and run your first agent.
