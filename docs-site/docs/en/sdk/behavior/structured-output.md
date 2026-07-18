# Structured output

Free-text answers are fine for chat, but when your agent feeds another program you want a **typed, validated result**, not prose to parse. Set `outputSchema` — a Zod object schema — and the run's final answer is forced through it: the SDK registers a `final_answer` tool with your schema as its parameters, instructs the model to call it exactly once when done, validates the arguments, and surfaces them as `result.output`.

## Usage

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { z } from "zod";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  outputSchema: z.object({
    name: z.string(),
    deps: z.number(),
  }),
});

const result = await agent.send("Summarize package.json");
result.output; // { name: "…", deps: 42 } — validated against the schema
```

`query()` accepts the same option. Its generator resolves to the `LiteAgentResult`, so drive it manually if you need `result.output`:

```ts
import { query } from "@lite-agent/sdk";

const run = query({
  prompt: "Summarize package.json",
  model: anthropic(),
  cwd: process.cwd(),
  outputSchema: z.object({ name: z.string(), deps: z.number() }),
});

let result;
while (!(result = await run.next()).done) {
  // stream events as usual: result.value is an AgentEvent
}
result.value.output; // LiteAgentResult.output
```

## How it works

1. A `final_answer` tool is registered with your schema as its parameter schema, so the model can only produce structurally valid arguments.
2. A `## Final answer` section is appended to the [system prompt](/sdk/behavior/system-prompt): the model must call `final_answer` exactly once when the task is complete, and only that call is read as the answer.
3. The tool handler records the validated arguments for the current session; when the run resolves, they are attached as `result.output`.

`LiteAgentResult` is `RunResult & { output?: unknown }` — `output` is only present when `outputSchema` is set and the model produced the final answer.

## Details

| Aspect | Behavior |
| --- | --- |
| Schema shape | Must be a Zod **object** schema; its fields become the `final_answer` parameters. |
| Validation | Arguments are validated by the schema before being recorded; malformed calls surface as ordinary tool errors the model can correct. |
| `result.output` | The validated arguments of the `final_answer` call for that session, attached to the `LiteAgentResult` returned by `send()` / `query()`. |
| Side effects | `final_answer` is declared with `network: "none"`, `filesystem: "none"`, `sideEffects: "none"` — it only records the answer. |
| Subagents | `outputSchema` is **not** inherited by [subagents](/sdk/tools/subagents); each child returns plain text. |

## See also

- [System prompt](/sdk/behavior/system-prompt) — how `outputSchema` extends the prompt with a `## Final answer` section.
- [Subagents](/sdk/tools/subagents) — why children don't inherit the schema.
- [Getting started](/sdk/getting-started) — install and run your first agent.
