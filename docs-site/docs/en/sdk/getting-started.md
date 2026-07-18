# Getting started

This page takes you from install to a permission-gated, multi-turn agent in four steps.

## 1. Install

```bash
pnpm add @lite-agent/sdk @lite-agent/provider zod
```

- `@lite-agent/sdk` — the batteries-included agent (`query` / `createLiteAgent` / `tool`); re-exports all of `@lite-agent/core`.
- `@lite-agent/provider` — model providers (`anthropic()` / `openai()`).
- `zod` — tool input schemas.

## 2. Your first `query()`

`query()` runs a one-shot agent and streams typed `AgentEvent`s:

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

Out of the box the agent already has the default tools (`bash`, `read_file`, `write_file`, `edit_file`, `delete_file`) scoped to `cwd`. The generator resolves to a `LiteAgentResult` (`messages`, `text`, `usage`, `stopReason`).

## 3. Add a custom tool

Define a tool from a Zod schema with `tool()`, pass it via `tools`, and gate the visible tool set with `allowedTools`:

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

`allowedTools` is an exact-name allow-list over the built-in tools plus your own — anything not listed is removed before the model ever sees it.

## 4. Multi-turn sessions + permission gate

`createLiteAgent(cfg)` returns a stateful `LiteAgent` that owns a current session — successive `send()` calls share the conversation. Add a `policy({ ask: [...] })` permission gate (tool-name glob matching, `deny > ask > allow`) and an `onApproval` handler to put a human in the loop:

```ts
import { createLiteAgent, policy } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { createInterface } from "node:readline/promises";

const agent = createLiteAgent({
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  // Every bash / write_file / edit_file call pauses for approval.
  permission: policy({ ask: ["bash", "write_file", "edit_file"] }),
  onApproval: {
    async request(call) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Allow ${call.name} ${JSON.stringify(call.input)}? [y/N] `);
      rl.close();
      return answer.trim().toLowerCase() === "y" ? "allow" : "deny";
    },
  },
});

const first = await agent.send("Create hello.txt with a short greeting.");
console.log(first.text);

const second = await agent.send("Now read it back to me."); // same session
console.log(second.text);
```

When the model calls `write_file`, the kernel emits an `approval_request` event, suspends the tool call, and waits for your handler to return `"allow"` or `"deny"`.

:::tip
The `LiteAgent` also gives you session management: `resume(id)`, `clear()`, `listSessions()`, `deleteSession(id)`, time-travel via `listCheckpoints(id)` / `restore(id, seq)`, and manual `compact()`. See [Sessions](/sdk/core-concepts/sessions) and [Checkpointing](/sdk/control/checkpointing).
:::

## See also

- [Agent loop](/sdk/core-concepts/agent-loop) — how the kernel turn loop works.
- [Events](/sdk/core-concepts/events) — the full `AgentEvent` reference.
- [Permissions](/sdk/control/permissions) — content-level rules, auditing, and dry-run.
- [Model providers](/core/providers) — Anthropic, OpenAI, and OpenAI-compatible local endpoints.
- [Core strategies](/core/strategies) — build your own agent from kernel primitives.
