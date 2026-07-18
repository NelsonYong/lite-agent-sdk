# @lite-agent/sdk

**English** | [简体中文](./README.zh-CN.md)

Batteries-included agent SDK over [`@lite-agent/core`](../core): a working tool set, skills, subagents, sessions, and a permission gate behind a small [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)-shaped API (`query` / `createLiteAgent` / `tool`). Pair it with a [`@lite-agent/provider`](../provider) for the model — every battery is a toggleable default over the core strategies.

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

`query()` streams typed `AgentEvent`s and resolves to a `LiteAgentResult`. For multi-turn work, `createLiteAgent(cfg)` returns a stateful `LiteAgent` that owns a current session — `send()`, `resume(id)`, `clear()`, `listSessions()`, `deleteSession(id)`, time-travel via `listCheckpoints(id)` / `restore(id, seq)`, and manual `compact()`.

### Long-lived background turns

Interactive consumers can subscribe once and keep receiving events after an
individual `run()` or `send()` has returned:

```ts
const agent = createLiteAgent({ model, workdir: process.cwd() });
const unsubscribe = agent.subscribe(({ sessionId, source, event }) => {
  render(sessionId, source, event); // includes autonomous background turns
});

await agent.send("Start the long review in the background");
await agent.send("Meanwhile, answer this separate question");

// On application shutdown:
unsubscribe();
await agent.close();
```

Ordinary `Agent` calls remain blocking. `run_in_background: true` on `Agent` or
`bash` returns immediately and keeps working across later turns of the same live
session. Completion wakes the originating session automatically; user and
completion turns for one session are serialized. In-flight work does not survive
a process restart. `query()` remains one-shot and closes its temporary background
work; use `createLiteAgent()` plus `subscribe()` for long-lived interaction.

## Features

- **Default tools** — `bash`, `read_file`, `write_file`, `edit_file`, `delete_file`, scoped to `workdir`, with atomic writes and pre-change snapshots so session restore can undo them.
- **Skills** — `SKILL.md` files loaded from `~/.lite-agent/skills`, `<workdir>/.lite-agent/skills`, or `skillsDir`; injected on demand via `load_skill`.
- **Subagents** — parallel-capable `Agent` dispatch tool with a built-in `general-purpose` agent; add your own as `agents/*.md` (`agents: false` to disable).
- **Tasks** — persistent task list (`TaskCreate/Update/Get/List`) with a per-turn reminder (`tasks: false` to disable).
- **Sessions** — event-sourced persistence via `fileCheckpointer`; swap in [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) or any `Checkpointer`.
- **Compaction** — deterministic default compactor (no LLM call), reactive overflow net, and disk spill for oversized tool results.
- **Permission gate** — `policy({ allow, ask, deny })` matched by tool-name glob (`deny > ask > allow`); pair with `onApproval` for human-in-the-loop and `permissionAudit: true` to persist redacted decisions.
- **Sandbox** — pass a `Sandbox` (e.g. [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic)) to run `bash` inside an OS boundary.
- **Human input** — an `ask_user` tool is registered when `onAskUser` is set, letting the model ask questions mid-run.
- **Structured output** — set `outputSchema` (a Zod object) to force a validated final answer, surfaced as `result.output`.
- **Background tasks** — enabled by default (`background: false` disables them); background Agent/Bash work continues across turns, with `bash_output` / `kill_background` for observation and control.
- **Local hardening** — configurable prompt codec/repair, context budget, snapshot limits, crash recovery, and hash-chained event sinks; strict defaults via [`@lite-agent/local`](../local).

## API

| Symbol | Description |
| --- | --- |
| `query(opts)` | One-shot agent run — `AsyncGenerator<AgentEvent, LiteAgentResult>`. |
| `createLiteAgent(cfg)` | Stateful, session-owning agent (`LiteAgent`) with `subscribe()` and `close()`. |
| `tool(name, description, schema, handler)` | Define a tool from a Zod schema. |
| `buildSystemPrompt(opts)` | The default system-prompt builder. |
| `defaultTools`, `bashTool`, `fileTools`, `taskTools`, `agentTool`, `askUserTool`, `bashOutputTool`, `killBackgroundTool` | Built-in tool sets, individually importable. |
| `policy`, `bashCommand`, `filePath`, `permissionFilePolicy` | Permission policies and content-level specifiers. |
| `fileCheckpointer`, `jsonlStore`, `fileTaskStore`, `fileSpillStore`, `fileContextArchive` | File-backed persistence adapters. |
| `jsonlEventSink`, `recordEventStream` | Event observability sinks. |
| `SkillLoader`, `loadSkillTool`, `AgentLoader`, `builtinAgents` | Skill and subagent loading. |
| `* from @lite-agent/core` | Full re-export of the kernel: types, events, strategies, middleware helpers. |

## Related

- [`@lite-agent/core`](../core) — the provider-agnostic kernel this package assembles.
- [`@lite-agent/provider`](../provider) — model providers (Anthropic, …).
- [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) · [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic) · [`@lite-agent/local`](../local) — pluggable backends and hardening.
- [Monorepo root](../..) — architecture overview; [`examples/cli`](../../examples/cli) — a full interactive REPL wiring provider + sandbox + permission + `ask_user`.
