# Strategies

Every moving part of the kernel is a strategy interface — one implementation per role, hot-swappable at agent construction. This is how lite-agent stays provider-agnostic and host-agnostic: instead of forking the kernel, you swap the part. All nine interfaces are exported as types from `@lite-agent/core`.

## Usage

Pass implementations into `createAgent` via `KernelConfig` — or accept the defaults and override only the roles you care about:

```ts
import { createAgent, nativeCodec, fakeProvider, textBlock } from "@lite-agent/core";

const agent = createAgent({
  model: fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]),
  codec: nativeCodec(),
});
```

**When to customize:** swap, don't fork. A local small model → `jsonCodec()` or `reactCodec()`; managed permissions → `composePolicies(...)`; durable sessions → the `Checkpointer` from a backend package. Write your own implementation of an interface only when the built-ins and sibling packages don't cover that role.

## The nine strategies

### `ModelProvider`

Streams normalized `ModelChunk`s (`text_delta` + a terminal `message_done`) for a `ModelRequest`. Pure adapter: it knows the vendor API, not tool semantics. May also expose optional `context` capabilities (`contextWindow`, `countTokens`, `clearToolUses`, `clearThinking`, `compact`, `promptCache`) that the ContextEngine prefers over local passes.

**Custom scenario:** wrap an in-house inference gateway behind `stream()` and the whole kernel — tools, checkpoints, middleware — works unchanged. See [Providers](/core/providers).

### `ToolCallCodec`

Encodes tool specs into the request and decodes an assistant message back into `{ text, calls }`. Prompt-based codecs declare `streaming: "buffer"` and can supply a `repairPrompt` used after decode failures.

**Custom scenario:** your fine-tuned local model speaks a bespoke `<<tool:...>>` syntax — implement `encode`/`decode` and plug it in. See [Tool-call codecs](/core/codecs).

### `Tool`

A zod-typed callable: `{ name, description, schema, security?, execute(input, ctx) }`. Define one with `defineTool`, and convert to a model-facing spec with `toToolSpec`. The kernel validates input against `schema` before `execute` runs; `ToolContext` carries `sessionId`, `signal`, `emit`, and optional `approval` / `input` / `sandbox` / `background` handles.

```ts
import { defineTool } from "@lite-agent/core";
import { z } from "zod";

const weather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});
```

**Custom scenario:** expose an internal search API as a tool — five lines, fully typed end to end.

### `Compactor`

`maybeCompact(messages, usage, instructions?) → CompactResult` — decides whether and how to shrink the conversation. `instructions` steers manual compaction (like Claude Code's `/compact <instructions>`); structural compactors ignore it.

**Custom scenario:** a domain-aware compactor that always preserves messages mentioning open Jira tickets. See [Context compaction](/core/compaction).

### `PermissionPolicy`

`check(call, ctx) → "allow" | "deny" | "ask"` (or a `PolicyVerdict` with rule provenance). It sees identity only — the `ToolCall` and `sessionId` — never `emit` or `signal`. Compose policies with `policy`, `strictPolicy`, `composePolicies`, and gate execution with the `permission` middleware.

**Custom scenario:** deny any tool call whose arguments touch files outside the workspace.

### `ApprovalHandler`

`request(call) → Promise<"allow" | "deny">`. Invoked when a policy answers `ask`; the loop parks until you resolve. A denial becomes a synthetic `isError` tool result — the tool never executes.

**Custom scenario:** route approvals to a Slack button in a hosted deployment.

### `InputHandler`

`request(question: UserQuestion) → Promise<UserAnswer>`. The symmetric counterpart of approval: the model asks (via an ask-user tool), the handler answers with free text or selected options.

**Custom scenario:** in a headless run, answer from a config file instead of prompting.

### `Store`

The legacy whole-array persistence seam: `load(id)` / `save(id, messages)`. Superseded by the event-sourced `Checkpointer`; a passed `Store` is adapted automatically via `legacyStoreAdapter`.

**Custom scenario:** you already persist transcripts in Postgres — keep your `Store`, the kernel adapts it. See [Persistence](/core/persistence).

### `Sandbox`

Wraps a shell command so it runs inside an OS-level boundary: `wrap(command, { cwd })`, plus optional `initialize`/`dispose`. The default is `noopSandbox()` — no boundary at all.

**Custom scenario:** run all shell tool commands inside a per-session Docker container.

## See also

- [The kernel](/core/kernel) — where each strategy plugs into the loop.
- [Middleware](/core/middleware) — layers around the loop, including the `permission` gate.
- [Providers](/core/providers) — ready-made `ModelProvider` implementations.
- [Codecs](/core/codecs) — `nativeCodec` / `jsonCodec` / `reactCodec`.
- [Persistence](/core/persistence) — `Checkpointer` backends.
