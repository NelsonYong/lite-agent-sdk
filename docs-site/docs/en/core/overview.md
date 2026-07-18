# Core overview

`@lite-agent/core` is the pluggable, event-driven agent kernel of lite-agent: a lean, provider-agnostic core built from swappable strategy interfaces, an onion middleware pipeline, and a typed event stream. Use it when you want to assemble your own agent from primitives — full control over the model, the tools, the persistence, and every layer in between — without forking a framework. Its public API is shaped after [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript), but the kernel is self-built, so it can also drive local small models via pluggable tool-call codecs.

## Getting started

```bash
pnpm add @lite-agent/core zod
```

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});

// Stream typed events…
for await (const ev of agent.run("hello")) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}

// …or await the final result.
const result = await agent.send("hello");
console.log(result.text);
```

`fakeProvider` is a built-in test double. For a real model, pass a `ModelProvider` — see [Providers](/core/providers).

## The design in three words

Everything in the kernel is one of three ideas:

- **Strategy** — a *swappable part*, one implementation per role, resolved at agent construction. There are nine: `ModelProvider`, `ToolCallCodec`, `Tool`, `Compactor`, `PermissionPolicy`, `ApprovalHandler`, `InputHandler`, `Store`, `Sandbox`. Swap, don't fork. See [Strategies](/core/strategies).
- **Middleware** — an *added layer* around the loop. Lifecycle hooks plus two wrappers (`wrapModelCall`, `wrapToolCall`) fold into the classic onion; permissions and compaction are just middleware, not kernel code. See [Middleware](/core/middleware).
- **Event** — a typed `AgentEvent` stream observes everything the loop does. Events are observational, never control flow. See [Events](/core/events).

The loop that ties them together — encode → call → decode → execute → feed back — is documented in [The kernel](/core/kernel).

## Core vs. SDK

The core knows nothing about permissions, compaction, or sessions by default — those are strategies and middleware you plug in. [@lite-agent/sdk](/sdk/overview) is the batteries-included composition of this same kernel: built-in tools, skills, subagents, sessions, and permission gating, with the ContextEngine enabled out of the box. Reach for the core when the SDK's defaults don't fit — an in-house inference gateway, a bespoke tool-call protocol, a custom persistence backend — and you want to wire the primitives yourself.

## See also

- [The kernel](/core/kernel) — the turn loop, step by step, and drain semantics.
- [Strategies](/core/strategies) — the nine swappable roles.
- [Middleware](/core/middleware) — the onion model and built-in layers.
- [Events](/core/events) — the full `AgentEvent` reference.
- [SDK overview](/sdk/overview) — the batteries-included agent built on this core.
