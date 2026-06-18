# @lite-agent/core

Pluggable, event-driven agent core SDK — a lean kernel plus strategy interfaces (model provider, tool-call codec, tools, compaction, permission, approval, input, store), an onion middleware pipeline, and a typed event stream.

> **Status: Phase 1 (foundation / walking skeleton).** Real local-model providers, permission + human approval, `ask_user`, context compaction, and sessions land in later phases.

## Quick start

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]),
  codec: nativeCodec(),
});

// Stream typed events
for await (const ev of agent.run("hello")) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}

// Or await the final result
const result = await agent.send("hello");
console.log(result.text);
```

## Concepts

- **Strategies** (swap a part): `ModelProvider`, `ToolCallCodec`, `Tool`, `Compactor`, `PermissionPolicy`, `ApprovalHandler`, `InputHandler`, `Store`.
- **Middleware** (compose cross-cutting behavior): `wrapModelCall`, `wrapToolCall`, and lifecycle hooks (`beforeAgent`/`afterAgent`/`beforeModel`).
- **Events** (observe / control): a typed `AgentEvent` stream from `run()`.
