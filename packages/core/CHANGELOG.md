# @lite-agent/core

## 0.3.0

### Minor Changes

- 94e4e45: feat: session management. `createLiteAgent` now returns a stateful `LiteAgent` that owns a current session and exposes `sessionId`, `resume(id)`, `clear()`, `deleteSession(id)`, and `listSessions()`. `jsonlStore` gains `list()`/`delete()` and is typed `SessionStore`; new `newSessionId`/`isSessionStore` helpers. The default session id is now a unique value instead of a process-local counter — fixing a cross-restart bug where a fresh run silently resumed (and kept growing) the previous run's `s1` transcript. The example CLI switches to server-side history and adds `/sessions`, `/resume`, `/clear`, `/delete`.
- b30b419: feat(sdk): subagents — a single parallel-capable `Agent` tool the main agent uses to delegate work (pass multiple `tasks` to fan out, bounded concurrency). A built-in `general-purpose` subagent is always available, so delegation works **out of the box with no configuration**; additional specialized agents load from `agents/*.md` (global `~/.lite-agent/agents` + project `<workdir>/.lite-agent/agents`) and a file named `general-purpose` overrides the built-in. Each subagent runs in an isolated, persisted (`agent-<id>.jsonl`), resumable session, shares the project task list, and runs under a lenient permission posture by default (the OS sandbox still applies). New `createLiteAgent`/`query` options `agents` (default on), `agentsDir`, and `subagentPermission`.
- 29f09a8: Replace the in-memory `todo` tool with a persistent Tasks API (`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`): one JSON file per task under `tasks/<listId>/`, bidirectional dependencies with cycle detection, cross-process file locking, and a per-turn `<system-reminder>` that re-injects the current task list without persisting it. New `createLiteAgent`/`query` options `tasks` (default on) and `taskListId`.

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
