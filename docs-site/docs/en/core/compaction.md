# Context compaction

Long-running agents eventually hit the model's context window. lite-agent's compaction capability shrinks the conversation **without breaking tool_call/tool_result pairing** — every cut is turn-aligned — and it comes in two composable layers: a deterministic toolkit you wire in as middleware, and an automatic ContextEngine that manages context pressure for you.

## Enabling compaction

Wire a compactor into the middleware pipeline with `compaction()`, and add `reactiveCompaction()` as the safety net:

```ts
import { createAgent, compaction, defaultCompactor, reactiveCompaction } from "@lite-agent/core";

const agent = createAgent({
  // model, codec, tools…
  use: [compaction(defaultCompactor()), reactiveCompaction()],
});
```

`compaction(compactor)` runs the compactor in `beforeModel` and swaps in the result, emitting a `compaction` event only when messages actually changed. `reactiveCompaction()` catches a context-overflow rejection from the provider and retries with a trimmed context — only if nothing has streamed yet.

:::info
When you build on `@lite-agent/sdk`, you usually configure nothing: the SDK passes `context: {}` by default, so the ContextEngine below is already active. The low-level core keeps raw-message behavior when `context` is omitted.
:::

## The toolkit

Deterministic passes and ready-made `Compactor`s, all exported from `@lite-agent/core`:

| Symbol | What it does |
| --- | --- |
| `compaction(compactor)` | `beforeModel` middleware that runs a compactor and swaps in the result, emitting a `compaction` event only when messages actually changed. |
| `defaultCompactor(opts?)` | Zero-API pipeline: `toolResultBudgetPass` (spill) → `snipPass` (drop whole middle turns, keep head + tail) → `microPass` (placeholder old tool-result bodies, keep the newest 3). All cuts are turn-aligned, so tool_call/tool_result pairing stays intact. |
| `llmCompactor(opts)` | Runs a deterministic base first, then — only if still over `tokenThreshold` — summarizes older turns into one message with a single model call. A circuit breaker (default 2 failures) falls back to the base so compaction can never wedge the run. |
| `tokenBudgetCompactor(opts)` | Keeps the newest turns that fit a hard `maxTokens` budget; drops older turns behind a marker. |
| `reactiveCompaction(opts?)` | The safety net: a `wrapModelCall` middleware that catches a context-overflow rejection, applies `reactiveTrim` (LLM-free, so it can never itself overflow), and retries — only if nothing streamed yet. |
| `memorySpillStore()` / `toolResultBudgetPass(opts)` | The spill mechanism: when combined tool-result bodies exceed `budgetBytes`, the largest bodies move off-context into a `SpillStore`, leaving a short retrievable marker (`SPILL_PREFIX`) in their place. Runs *before* micro, so full content survives. |
| `snipPass` / `microPass` / `splitTurns` / `runPipeline` / `estimateTokens` | Building blocks for assembling your own `CompactPass` pipeline (passable wholesale via `defaultCompactor({ passes })`). |

Every compactor implements the `Compactor` strategy — `maybeCompact(messages, usage, instructions?) → CompactResult`. The optional `instructions` steers manual compaction (like Claude Code's `/compact <instructions>`); structural compactors ignore it.

## The ContextEngine

The ContextEngine is automatic, always-on context management, created by the kernel when `context` is not `false`. It owns a durable event log and projects a `ContextView` per request, escalating through internal pressure levels (externalize → normalize → select → project → recover) and reporting each decision as one `context_status` event. It prefers provider-native capabilities (`clearToolUses`, `clearThinking`, `compact`) when the `ModelProvider` exposes them, and accepts `planner` / `archive` hooks via `KernelContextOptions`.

Create one standalone with `createContextEngine`, or project a view yourself with `projectContext`.

## See also

- [The nine strategies](/core/strategies) — the `Compactor` strategy interface and custom compactor scenarios.
- [Model providers](/core/providers) — which providers expose native context-editing capabilities.
- [Session persistence](/core/persistence) — the event log the ContextEngine builds on.
- [Tool-call codecs](/core/codecs) — how history is encoded after compaction.
