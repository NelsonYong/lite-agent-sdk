# Custom tools

Tools are how the model acts on the world. Beyond the [built-in tools](/sdk/tools/builtin-tools), `tool()` lets you define your own — a typed function the model can call — from a Zod schema. The schema validates every call before your code runs, so your handler only ever sees well-formed input. Custom tools are appended after the built-ins and go through the same [permission gate](/sdk/control/permissions) and `allowedTools` / `disallowedTools` filtering.

## Defining a tool

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

## The `tool()` signature

```ts
tool(name, description, schema, handler, opts?)
```

| Argument | Description |
| --- | --- |
| `name` | Tool name the model calls (matched by `allowedTools` / `disallowedTools` and permission rules). |
| `description` | Shown to the model; tell it when and why to use the tool. |
| `schema` | A Zod schema. Invalid model input is rejected before your handler runs. |
| `handler` | `(input, ctx: ToolContext) => string \| Promise<string>` — the return value is the tool result the model sees. |
| `opts.security` | Optional [security metadata](#security-metadata). |

## `ToolContext`

The handler's second argument carries per-call services provided by the kernel:

| Field | Description |
| --- | --- |
| `sessionId` | The session this call belongs to. |
| `signal` | `AbortSignal` for cancellation. |
| `emit(ev)` | Emit a custom `AgentEvent` mid-call. |
| `approval` / `input` | The approval / user-input handlers, if configured. |
| `sandbox` | The active `Sandbox` strategy, if any. |
| `background` | Background task registry, when `background` is enabled. |
| `call` | The raw `ToolCall` being executed. |
| `recordSnapshot(...)` | Record a file's pre-mutation content so session restore can undo it (provided only when a checkpointer is active). |

## Security metadata

`opts.security` declares what a tool can reach, typed as `ToolSecurity`:

| Field | Values | Meaning |
| --- | --- | --- |
| `network` (required) | `"none"` \| `"loopback"` \| `"private"` \| `"unrestricted"` | Network reachability of the tool. |
| `filesystem` | `"none"` \| `"workspace"` \| `"unrestricted"` | Filesystem scope the tool touches. |
| `sideEffects` | `"none"` \| `"workspace"` \| `"external"` | Where the tool's side effects land. |

Strict assemblers consume this metadata: `@lite-agent/local` refuses custom tools that lack `security` or declare `network` beyond `"loopback"`. Declare it honestly — it is what lets hardened presets decide whether your tool may run.

## See also

- [Built-in tools](/sdk/tools/builtin-tools) — the tool set that ships with the SDK.
- [Permissions](/sdk/control/permissions) — gate custom and built-in tools with allow / ask / deny rules.
- [Agent SDK overview](/sdk/overview) — where custom tools fit in the assembled agent.
- [CLI example](/examples/cli) — a full agent wiring custom tools end to end.
