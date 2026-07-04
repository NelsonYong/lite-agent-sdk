# @lite-agent/sdk

**English** | [简体中文](./README.zh-CN.md)

Batteries-included agent SDK built on [`@lite-agent/core`](../core). It assembles the kernel with a working tool set (bash + file ops), skills, subagents, a persistent task list, a built system prompt, sessions, compaction, and an optional permission gate — exposed through a small [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)-shaped API (`query` / `createLiteAgent` / `tool`).

Pair it with a [`@lite-agent/provider`](../provider) for the model. Everything is optional and swappable — the batteries are just sensible defaults over the core strategies.

## Install

```bash
pnpm add @lite-agent/sdk @lite-agent/provider zod
```

## Quick start — `query()`

The one-shot facade. Streams a typed `AgentEvent` stream and returns a `RunResult`.

```ts
import { query } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

for await (const ev of query({
  prompt: "List the files here and summarize what this project does.",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  cwd: process.cwd(),
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}
```

## `createLiteAgent()` — a stateful agent

Owns a current session, so `send` / `run` are multi-turn by default. Add your own tools with `tool()`, and gate dangerous ones with a permission `policy`.

```ts
import { createLiteAgent, tool, policy } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { z } from "zod";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  tools: [
    tool(
      "get_weather",
      "Get the weather for a city",
      z.object({ city: z.string() }),
      async ({ city }) => `It's sunny in ${city}.`,
    ),
  ],
  // Ask before running side-effecting built-ins; everything else runs freely.
  permission: policy({ ask: ["bash", "write_file", "edit_file"] }),
  onApproval: { request: async (call) => "allow" }, // your UI decides
});

await agent.send("Remember my name is Nelson.");
const result = await agent.send("What's my name, and what's the weather in Tokyo?");
console.log(result.text); // same session — it remembers
```

Session management on the returned `LiteAgent`: `sessionId`, `resume(id)`, `clear()`, `listSessions()`, `deleteSession(id)`, plus time-travel — `listCheckpoints(id)` / `restore(id, seq)` (rewinds files and/or conversation) and a manual `compact()`.

## What's in the box

Assembled by `createLiteAgent` (each toggleable):

- **Default tools** — `bash`, `read_file`, `write_file`, `edit_file`, all scoped to `workdir`.
- **Skills** — `SKILL.md` files (YAML frontmatter) loaded from `~/.lite-agent/skills`, `<workdir>/.lite-agent/skills`, and an explicit `skillsDir`; injected on demand via `load_skill`.
- **Subagents** — a parallel-capable `Agent` dispatch tool with a built-in `general-purpose` agent; add your own as `agents/*.md`. (`agents: false` to disable.)
- **Tasks** — a persistent task list (`TaskCreate/Update/Get/List`) with a per-turn reminder. (`tasks: false` to disable.)
- **Sessions** — event-sourced persistence via a `fileCheckpointer` under the project dir; swap in [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) or any `Checkpointer`.
- **Compaction** — a deterministic default compactor (no LLM call) plus a reactive overflow net; disk-**spill** for oversized tool results.
- **Permission gate** — `policy({ allow, ask, deny })` matched by tool-name glob (`deny > ask > allow`); pair with `onApproval` for human-in-the-loop.
- **Sandbox** — pass a `Sandbox` (e.g. [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic)) to run `bash` inside an OS boundary.
- **`ask_user`** — registered when `onAskUser` is set, letting the model ask you questions mid-run.
- **Structured output** — set `outputSchema` (a Zod object) to force a validated final answer, surfaced as `result.output`.

## API

- `query(opts)` → `AsyncGenerator<AgentEvent, LiteAgentResult>` — one-shot.
- `createLiteAgent(cfg)` → `LiteAgent` — stateful, session-owning agent.
- `tool(name, description, schema, handler)` — define a tool from a Zod schema.
- `buildSystemPrompt(opts)` — the default system prompt builder.
- Re-exports everything from [`@lite-agent/core`](../core) (types, events, strategies, middleware helpers).

See the [monorepo root](../..) for architecture, and [`examples/cli`](../../examples/cli) for a full interactive REPL wiring provider + sandbox + permission + `ask_user`.
