# @lite-agent/core

## 0.2.0

### Minor Changes

- b30f11b: feat: session persistence/resume, retry middleware, and context compaction

  P0 capability wave — all additive and opt-in (no breaking changes):

  - **Sessions / resume (P0-2):** `memoryStore()` (core) and `jsonlStore({ dir })` (sdk) implement the `Store` strategy. The kernel now loads a session's transcript at start and persists per tool-turn + at the end. Threaded through `createAgent` / `createLiteAgent` / `query` via a new optional `store`.
  - **Retry (P0-3):** `retry({ maxRetries, backoff, retryOn })` — a `wrapModelCall` middleware that retries transient `ProviderError`s (408/409/425/429/5xx + network), and never re-runs after output has started streaming.
  - **Context compaction (P0-1):** `core/src/compaction/` — composable `CompactPass` bricks (`snipPass` turn-aware middle-drop, `microPass` tool_result shrink) wired through `runPipeline` into `defaultCompactor()` (the `Compactor` strategy) and a `compaction()` `beforeModel` middleware; plus `reactiveCompaction()` — an LLM-free `wrapModelCall` safety net that trims and retries on 413 / `prompt_too_long`. `createLiteAgent({ compactor })` wires the proactive + reactive layers together. `llmCompactor()` (L4) is an optional LLM-summary `Compactor` that composes a deterministic base and summarizes older turns once over a token threshold, with a circuit breaker. `toolResultBudgetPass` + `SpillStore` (`memorySpillStore` / `fileSpillStore`) + `readSpilledTool` (L3) move oversized tool-result bodies off-context to disk behind a retrievable `[spilled:ref]` marker; `defaultCompactor({ spillStore })` runs it first in the pipeline.
  - **Kernel:** the model request is now encoded inside the `ModelCall` (so a `wrapModelCall` middleware can mutate `ctx.messages` and retry against the new context), and `ctx.messages` is re-synced after the model call so such mutations land in the result and the store.

## 0.1.0

### Minor Changes

- ce5c1e8: Initial 0.1.0 release of the pluggable agent-core SDK.

  - **@lite-agent/core** — event-driven kernel, strategy interfaces (provider/codec/tool/compactor/permission/approval/input/sandbox/store), onion middleware pipeline, normalized types, native codec, `policy()` + `permission()` gate.
  - **@lite-agent/provider** — Anthropic Messages API + OpenAI Chat Completions providers in one package (OpenAI also works with OpenAI-compatible / local endpoints). The example picks the provider by detecting the protocol from `LITE_AGENT_MODEL_ID`.
  - **lite-agent** — batteries layer: `createLiteAgent`/`query`, bash/file/todo + `ask_user` tools, skills loader, system prompt.
  - **@lite-agent/sandbox-anthropic** — OS-level sandbox adapter with graceful degradation.

- v0.1.0
