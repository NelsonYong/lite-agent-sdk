# @lite-agent/core

The pluggable, event-driven agent kernel for lite-agent: a lean, provider-agnostic core built from swappable strategy interfaces, an onion middleware pipeline, and a typed event stream. Use it to build your own agent from primitives — for a batteries-included setup (tools, skills, subagents, sessions), use [@lite-agent/sdk](/packages/sdk) instead.

Its public API is shaped after [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript), but the kernel is self-built, so it can also drive local small models via pluggable tool-call codecs.

```bash
pnpm add @lite-agent/core zod
```

## Quick start

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

`fakeProvider` is a built-in test double. For a real model, pass a `ModelProvider` from [@lite-agent/provider](/packages/provider) (`anthropic()` / `openai()`).

## The kernel turn loop

`createAgent(config)` assembles a `KernelConfig` and returns an `Agent` with two entry points:

- `run(input, opts?)` — an async generator that yields every `AgentEvent` and returns the `RunResult`.
- `send(input, opts?)` — drains the same generator and resolves with just the `RunResult`.

Both accept `{ signal, sessionId, steer }` via `RunOptions`. Inside, one run of the kernel looks like this:

1. **Load the session.** If a `checkpointer` is configured, the event log is replayed and `foldEvents` rebuilds the message list; with `crashRecovery: "safe"`, tools that started but never finished get a synthetic error `tool_result`.
2. **Run `beforeAgent` hooks** (once per run), then drain the event queue.
3. **Start a turn** — yield `turn_start`, apply pending steers and background-task completions, then run `beforeModel` hooks (this is where compaction middleware lives).
4. **Call the model.** The request is encoded by the `ToolCallCodec`, streamed through the `wrapModelCall` middleware chain, and surfaced as `text_delta` events. A context-overflow error before any chunk streamed triggers one emergency compaction + retry when the ContextEngine is active.
5. **Decode the response.** The codec normalizes the assistant message into text + `ToolCall[]`. Malformed prompt-codec output throws `CodecError`; the kernel appends the codec's `repairPrompt` and retries (default 2 attempts via `maxDecodeRetries`).
6. **Stop or execute tools.** No tool calls → `turn_end(stop)` and the loop exits (unless steers/background tasks resurrect it). Otherwise all `tool_use` events are announced up front, then each call runs through the `wrapToolCall` chain — schema-validated, executed, and turned into a `ToolResult`. Up to `maxParallelTools` (default 10) run concurrently; tool-phase events stream live in completion order, while the model-facing message is assembled in input order.
7. **Feed results back** as one user message of `tool_result` blocks, yield `turn_end(tool_use)`, and loop — until `stop`, `aborted`, or `maxTurns`.
8. **Finish.** Run `afterAgent` hooks, yield `done` with the `RunResult` (`messages`, `text`, `usage`, `stopReason`).

The kernel itself knows nothing about permissions or compaction — those are middleware. The loop body is just "encode → call → decode → execute → feed back".

:::tip
Abort is observed at turn boundaries: pass an `AbortSignal` via `run(input, { signal })` and the generator finishes with `done(reason: "aborted")`.
:::

## Events and the drain semantics

Every run yields a single discriminated union, `AgentEvent`: `turn_start`, `model_call_start`/`model_call_end`, `text_delta`, `message`, `tool_use`, `tool_call_start`/`tool_call_end`, `tool_result`, `approval_request`/`approval_resolved`, `input_request`/`input_resolved`, `permission_decision`, `compaction`, `context_status`, `steer`, `background_completed`, `turn_end`, `error`, `done`, and a few more. Events from a forwarded subagent carry an `agentId`.

Two properties matter when you consume or emit events:

- **Events are observational, not control flow.** Middleware and tools call `ctx.emit(ev)`; the kernel buffers those events in a queue and *drains* it at loop boundaries (after hooks, after the model call, before the next turn). Emitting never pauses the loop, and a slow consumer never blocks the kernel.
- **Interactive handlers block on their own I/O.** When an `ApprovalHandler` or `InputHandler` is in play, the kernel emits `approval_request` / `input_request` and then `await`s `handler.request(...)`. The loop genuinely parks on that promise — your CLI reads stdin, your web handler waits for a button click — and resumes when you resolve it. The event stream and the pause live in the same process; nothing is persisted mid-question.

During the tool phase the queue is replaced by a live channel so concurrent tools (and forwarded subagent events) surface in real time, in completion order.

## The nine strategies

Every moving part of the kernel is a strategy interface — one implementation per role, hot-swappable. All are exported as types from `@lite-agent/core`.

### `ModelProvider`

Streams normalized `ModelChunk`s (`text_delta` + a terminal `message_done`) for a `ModelRequest`. Pure adapter: it knows the vendor API, not tool semantics. May also expose optional `context` capabilities (`contextWindow`, `countTokens`, `clearToolUses`, `clearThinking`, `compact`, `promptCache`) that the ContextEngine prefers over local passes.

**Custom scenario:** wrap an in-house inference gateway behind `stream()` and the whole kernel — tools, checkpoints, middleware — works unchanged.

### `ToolCallCodec`

Encodes tool specs into the request and decodes an assistant message back into `{ text, calls }`. Prompt-based codecs declare `streaming: "buffer"` and can supply a `repairPrompt` used after decode failures. See [Tool-call codecs](#tool-call-codecs).

**Custom scenario:** your fine-tuned local model speaks a bespoke `<<tool:...>>` syntax — implement `encode`/`decode` and plug it in.

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

`maybeCompact(messages, usage, instructions?) → CompactResult` — decides whether and how to shrink the conversation. `instructions` steers manual compaction (like Claude Code's `/compact <instructions>`); structural compactors ignore it. See [Context compaction](#context-compaction).

**Custom scenario:** a domain-aware compactor that always preserves messages mentioning open Jira tickets.

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

The legacy whole-array persistence seam: `load(id)` / `save(id, messages)`. Superseded by the event-sourced [`Checkpointer`](#checkpointer-primitives); a passed `Store` is adapted automatically via `legacyStoreAdapter`.

**Custom scenario:** you already persist transcripts in Postgres — keep your `Store`, the kernel adapts it.

### `Sandbox`

Wraps a shell command so it runs inside an OS-level boundary: `wrap(command, { cwd })`, plus optional `initialize`/`dispose`. The default is `noopSandbox()` — no boundary at all. A real boundary lives in [@lite-agent/sandbox-anthropic](/packages/sandbox-anthropic).

**Custom scenario:** run all shell tool commands inside a per-session Docker container.

## Middleware: the onion model

A `Middleware` can implement lifecycle hooks and two wrappers:

```ts
interface Middleware {
  name: string;
  beforeAgent?(ctx: AgentContext): void | Promise<void>;
  afterAgent?(ctx: AgentContext): void | Promise<void>;
  beforeModel?(ctx: AgentContext): void | Promise<void>;
  wrapModelCall?(ctx: AgentContext, next: ModelCall): AsyncIterable<ModelChunk>;
  wrapToolCall?(ctx: ToolCallContext, next: ToolExec): Promise<ToolResult>;
}
```

`composeModelCall` and `composeToolCall` fold the middleware array around the base call with `reduceRight` — **array order is outer → inner**. Given `use: [a, b]`, a model call flows `a → b → provider → b → a`, the classic onion. `runLifecycle` simply runs each hook in array order. `AgentContext` is the only handle middleware gets: `sessionId`, mutable `messages`, `turn`, `signal`, `emit`, a shared `state` map, and `recordSessionEvent` for persisting custom facts. No globals.

```ts
import type { Middleware } from "@lite-agent/core";

const logging: Middleware = {
  name: "logging",
  async *wrapModelCall(ctx, next) {
    console.time(`turn ${ctx.turn}`);
    yield* next();
    console.timeEnd(`turn ${ctx.turn}`);
  },
};

createAgent({ /* … */, use: [logging] });
```

Built-in middleware proves the seam: `retry()` (transient-failure retries with jittered backoff), `compaction(compactor)` (runs a `Compactor` in `beforeModel`), `reactiveCompaction()` (catches context-overflow, trims, retries), and `permission(...)` (policy gate). You can reorder, replace, or drop any of them.

## Tool-call codecs

The codec is what makes the kernel provider-agnostic in both directions: the same kernel drives a frontier API with native function calling or a local 7B model with prompt engineering.

| Codec | Protocol | Streaming | Use it when |
| --- | --- | --- | --- |
| `nativeCodec()` | Tool specs passed as native `tools`; calls arrive as structured blocks | passthrough | The provider has real function calling (Anthropic, OpenAI). The default choice. |
| `jsonCodec(opts?)` | Whole-response JSON protocol injected into `system`: `{"type":"tool_calls","calls":[…]}` or `{"type":"final","text":…}` | buffer | The model follows instructions well but has no native tool API (most local models). |
| `reactCodec(opts?)` | ReAct text: `Action:` / `Action Input:` / `Observation:` / `Final Answer:`, one tool per response | buffer | Small models that parse better with a textual reasoning trace than strict JSON. |

Both prompt codecs ship protocol instructions in the system prompt, rewrite history into their textual format on `encode`, buffer output until it decodes cleanly, and provide a `repairPrompt` so the kernel can ask the model to fix malformed output instead of failing the run (`maxDecodeRetries`, default 2). Pass `instructions` to append your own protocol guidance.

## Context compaction

Two layers, both optional and composable:

**The toolkit** — deterministic passes and ready-made `Compactor`s:

| Symbol | What it does |
| --- | --- |
| `compaction(compactor)` | `beforeModel` middleware that runs a compactor and swaps in the result, emitting a `compaction` event only when messages actually changed. |
| `defaultCompactor(opts?)` | Zero-API pipeline: `toolResultBudgetPass` (spill) → `snipPass` (drop whole middle turns, keep head + tail) → `microPass` (placeholder old tool-result bodies, keep the newest 3). All cuts are turn-aligned, so tool_call/tool_result pairing stays intact. |
| `llmCompactor(opts)` | Runs a deterministic base first, then — only if still over `tokenThreshold` — summarizes older turns into one message with a single model call. A circuit breaker (default 2 failures) falls back to the base so compaction can never wedge the run. |
| `tokenBudgetCompactor(opts)` | Keeps the newest turns that fit a hard `maxTokens` budget; drops older turns behind a marker. |
| `reactiveCompaction(opts?)` | The safety net: a `wrapModelCall` middleware that catches a context-overflow rejection, applies `reactiveTrim` (LLM-free, so it can never itself overflow), and retries — only if nothing streamed yet. |
| `memorySpillStore()` / `toolResultBudgetPass(opts)` | The spill mechanism: when combined tool-result bodies exceed `budgetBytes`, the largest bodies move off-context into a `SpillStore`, leaving a short retrievable marker (`SPILL_PREFIX`) in their place. Runs *before* micro, so full content survives. |
| `snipPass` / `microPass` / `splitTurns` / `runPipeline` / `estimateTokens` | Building blocks for assembling your own `CompactPass` pipeline (passable wholesale via `defaultCompactor({ passes })`). |

**The ContextEngine** — automatic, always-on context management, created by the kernel when `context` is not `false`. It owns a durable event log and projects a `ContextView` per request, escalating through internal pressure levels (externalize → normalize → select → project → recover) and reporting each decision as one `context_status` event. It prefers provider-native capabilities (`clearToolUses`, `clearThinking`, `compact`) when the `ModelProvider` exposes them, and accepts `planner` / `archive` hooks via `KernelContextOptions`. Create one standalone with `createContextEngine`, or project a view yourself with `projectContext`.

:::info
The low-level core keeps raw-message behavior when `context` is omitted; [@lite-agent/sdk](/packages/sdk) passes `{}` by default, so SDK agents get the ContextEngine out of the box.
:::

## Checkpointer primitives

Session persistence is event-sourced. The canonical persisted unit is a `SessionEvent` (`user`, `assistant`, `tool_started`, `tool_result`, `file_snapshot`, `artifact_verified`, `permission_decision`, `summary`, `context_view`), stored as a `StoredEvent` with a monotonic `seq` and `parentSeq` link.

```ts
interface Checkpointer {
  append(sessionId: string, events: SessionEvent[], expectedHead?: number): Promise<number>;
  read(sessionId: string, opts?: { sinceSeq?: number }): AsyncIterable<StoredEvent>;
  head(sessionId: string): Promise<number>;
  list(): Promise<SessionInfo[]>;
  delete(sessionId: string): Promise<void>;
  truncate?(sessionId: string, toSeq: number): Promise<void>;
}
```

Passing `expectedHead` to `append` gives optimistic concurrency — a mismatch throws `CheckpointConflictError`. Because the log is the source of truth, `truncate` + replay is time travel: fork a session from any point.

- `memoryCheckpointer()` — the in-memory implementation, for tests and ephemeral runs. Durable backends live in [@lite-agent/checkpoint-sqlite](/packages/checkpoint-sqlite).
- `foldEvents(events)` — rebuilds the conversation from a log: consecutive `tool_result` events coalesce into one user message (reproducing the kernel's turn shape), and a `summary` event resets the transcript.
- `storeEvents(sessionId, fromSeq, events)` — stamps raw `SessionEvent`s into `StoredEvent`s with `seq`/`parentSeq`/`ts`; the building block for writing your own backend.
- `legacyStoreAdapter(store)` — wraps a legacy whole-array `Store` as a `Checkpointer`, so existing storage keeps working.

## Error hierarchy

All kernel errors extend `AgentError`, so one `instanceof` catches the family:

| Class | Raised when | Extra fields |
| --- | --- | --- |
| `ProviderError` | The provider stream fails (HTTP, network, overflow) | `status?: number` |
| `ToolError` | Tool infrastructure fails | — |
| `CodecError` | A prompt codec cannot decode the model's output | — |
| `MaxTurnsError` | The turn budget is exceeded | — |
| `AbortError` | The run's `AbortSignal` fires | — |
| `CheckpointConflictError` | An `append` sees a stale `expectedHead` | `sessionId`, `expected`, `actual` |

Non-fatal failures (a retried model call, a codec repair attempt) surface as `{ type: "error", fatal: false }` events before any throw, so observers see the full story.

## Testing utilities

- **`fakeProvider(turns)`** — a `ModelProvider` test double that replays scripted `FakeTurn`s (`{ text?, message, usage? }`). Deterministic, no network; used throughout the quick start above.
- **`providerConformance`** — an array of named test cases (`text` ordering, single terminal `message_done`, error mapping to `ProviderError`, abort) that any `ModelProvider` must pass. Feed it a `ProviderConformanceFactory` that builds your provider for each `ProviderConformanceScenario`:

```ts
import { providerConformance } from "@lite-agent/core";

for (const test of providerConformance) {
  it(test.name, () => test.run((scenario) => makeMyProvider(scenario)));
}
```

- **`checkpointerConformance`** — the same idea for `Checkpointer` backends: monotonic seq, `sinceSeq` replay, conflict rejection, list/delete, serialized concurrent appends, payload round-trip. [@lite-agent/checkpoint-sqlite](/packages/checkpoint-sqlite) validates itself against this suite.

```ts
import { checkpointerConformance } from "@lite-agent/core";

for (const test of checkpointerConformance) {
  it(test.name, () => test.run(() => myCheckpointer()));
}
```

## Related

- [@lite-agent/sdk](/packages/sdk) — batteries-included agent composed from this core.
- [@lite-agent/provider](/packages/provider) — `ModelProvider` implementations (`anthropic()`, `openai()`).
- [@lite-agent/checkpoint-sqlite](/packages/checkpoint-sqlite) — durable `Checkpointer` backend.
- [@lite-agent/sandbox-anthropic](/packages/sandbox-anthropic) — OS-level sandbox boundary.
- [@lite-agent/local](/packages/local) — local-model support.
- [Getting started](/guide/getting-started) — build your first agent.
