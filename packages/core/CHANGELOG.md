# @lite-agent/core

## 0.8.0

### Minor Changes

- afbb084: Support steering manual compaction with free-text instructions. `Compactor.maybeCompact(messages, usage, instructions?)` gains an optional instruction string; `llmCompactor` appends it to the summary prompt (append, not override) so a summary can be biased toward what matters. The parameter is optional, so existing `Compactor` implementations and automatic/proactive compaction are unaffected.

## 0.7.0

### Minor Changes

- 2d0e4b9: Add a manual, durable compaction action. `LiteAgent.compact()` compresses the current session's conversation using the configured compactor, persists the result as a new `summary` event (so it survives reloads and composes with restore), emits `compaction` progress + completion events, then stops — it never produces a model answer. `foldEvents` now treats `summary` as a base reset, so loading a compacted session uses the compressed view with no kernel change.
- 795c10d: Add session restore. A new `file_snapshot` sidecar event records the pre-mutation content of files changed via `write_file`/`edit_file`; `LiteAgent.restore(id, toSeq, { conversation?, files? })` rolls a session back to a checkpoint — reverting those files and/or truncating the conversation — and `listCheckpoints(id)` enumerates the rewind anchors. `Checkpointer` gains an optional `truncate`. Like Claude Code, files changed by `bash` are not tracked.

## 0.6.0

### Minor Changes

- d39189e: Stream tool-phase events to consumers in real time (completion order) via an internal push channel, instead of buffering them until the tool pool drains. Subagent events are now forwarded live to the parent event stream, tagged with an optional `agentId` so UIs can route concurrent subagents to their own lanes. The model-facing context is unchanged: tool_result blocks are still assembled in input order and id-matched. Additive — consumers that ignore `agentId` and don't depend on concurrent-tool event ordering are unaffected.
- 33d9c4e: Add turn-boundary steering: a `SteerController` (mirroring `AbortController`) with `steer(msg)` to inject input before the next model turn and `followUp(msg)` to continue a run that would otherwise stop. Pass it via `run`/`query` options (`{ steer }`). Injections surface as an additive `steer` event. No interruption of in-flight model streams. Purely additive — runs without a controller are unchanged.

### Patch Changes

- a2d41fd: Replace hand-rolled internals with maintained libraries: the two concurrency worker-pools (kernel tool pool, Agent subagent pool) now use `p-limit`, and the permission tool-name matcher uses `picomatch` instead of a hand-rolled glob→regexp. Behavior is unchanged for existing tool-name patterns; the permission matcher additionally supports brace (`{a,b}`) and character-class (`[…]`) globs.

## 0.5.2

## 0.5.1

### Patch Changes

- Checkpoint follow-ups: run `memoryCheckpointer` through the shared
  `checkpointerConformance` suite for backend parity, and make
  `legacyStoreAdapter.head()` consistent with `append` by reading the per-session
  head cache (behavior is unchanged for round-tripping stores). Also adds a
  multi-client optimistic-concurrency test for the SQLite backend.

## 0.5.0

### Minor Changes

- c695991: Event-sourced checkpoint persistence

  The session store is now an append-only, event-sourced `Checkpointer`: a per-session
  log of `SessionEvent`s keyed by a monotonic `seq`, folded back into messages on load
  (`foldEvents`). The kernel appends `user`/`assistant`/`tool_result` events as they
  occur — each tool result is persisted the moment it completes, closing the mid-turn
  data-loss window under concurrent tool execution. New API: `Checkpointer`,
  `memoryCheckpointer`, `fileCheckpointer` (the new default), `legacyStoreAdapter`,
  `foldEvents`, `CheckpointConflictError`, plus optimistic multi-client concurrency via
  `expectedHead`. The legacy `Store` (`jsonlStore`/`memoryStore`) still works via
  `legacyStoreAdapter`. Old whole-array transcripts are not migrated and are swept on
  cleanup.

- fefb68f: Add model sampling and tool-selection controls

  `ModelRequest` gains `temperature`, `topP`, `toolChoice`, and `seed`, threaded through
  `KernelConfig` → `createAgent` → `createLiteAgent` / `query` (and inherited by subagents).
  `toolChoice` is normalized as `"auto" | "none" | "required" | { tool: string }`.

  Both providers forward the new fields: the OpenAI mapping emits `temperature` / `top_p` /
  `seed` / `tool_choice`; the Anthropic mapping emits `temperature` / `top_p` and maps
  `tool_choice` to its `auto` / `none` / `any` / `tool` shapes (`seed` is unsupported by
  Anthropic and intentionally ignored). `tool_choice` is only sent when tools are present.

### Patch Changes

- c99328b: Harden the `retry()` middleware

  - Default backoff now applies **full jitter** (a random delay in `[0, ceiling]`) so
    many agents recovering from the same transient failure don't retry in lockstep.
    A caller-supplied `backoff` is still used verbatim.
  - Retries are now **abort-aware**: an aborted run stops retrying immediately and
    interrupts an in-progress backoff wait instead of sleeping it out.
  - Each retried failure emits a non-fatal `error` event (`fatal: false`) for observability.

## 0.4.0

### Minor Changes

- a349701: feat: run a turn's tool calls concurrently (default-on; cap `maxParallelTools`, default 10)

  The kernel now executes all tool calls of a single assistant turn in parallel,
  bounded by `maxParallelTools` (default 10; set to 1 for the old sequential
  behavior). Output stays deterministic — `tool_result` blocks and events flush in
  input order regardless of completion timing — and the permission gate serializes
  concurrent approval prompts so they never overlap. Multiple `Agent` (subagent)
  calls in one turn now fan out simultaneously instead of running one after another.

  Event-stream note: for multi-tool turns, all `tool_use` events are now emitted up
  front (before any tool runs), rather than interleaved with each call's result.

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
