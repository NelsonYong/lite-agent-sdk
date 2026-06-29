# lite-agent

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

- 7fc43a8: Add `outputSchema` for structured final answers

  `createLiteAgent` and `query` accept an `outputSchema` (a Zod object schema). When set,
  a `final_answer` tool whose parameters are that schema is registered and the model is
  instructed to call it when done. The validated arguments surface as `result.output`
  (typed via the new `LiteAgentResult`). Because the answer travels through a tool call
  rather than free text, it is robust for reasoning models (whose replies contain `<think>`
  blocks) and small local models. Subagents do not inherit `outputSchema` — they still
  return their answer as text.

### Patch Changes

- Updated dependencies [c695991]
- Updated dependencies [fefb68f]
- Updated dependencies [c99328b]
  - @lite-agent/core@0.5.0

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

### Patch Changes

- Updated dependencies [a349701]
  - @lite-agent/core@0.4.0

## 0.3.0

### Minor Changes

- 94e4e45: feat: session management. `createLiteAgent` now returns a stateful `LiteAgent` that owns a current session and exposes `sessionId`, `resume(id)`, `clear()`, `deleteSession(id)`, and `listSessions()`. `jsonlStore` gains `list()`/`delete()` and is typed `SessionStore`; new `newSessionId`/`isSessionStore` helpers. The default session id is now a unique value instead of a process-local counter — fixing a cross-restart bug where a fresh run silently resumed (and kept growing) the previous run's `s1` transcript. The example CLI switches to server-side history and adds `/sessions`, `/resume`, `/clear`, `/delete`.
- b30b419: feat(sdk): subagents — a single parallel-capable `Agent` tool the main agent uses to delegate work (pass multiple `tasks` to fan out, bounded concurrency). A built-in `general-purpose` subagent is always available, so delegation works **out of the box with no configuration**; additional specialized agents load from `agents/*.md` (global `~/.lite-agent/agents` + project `<workdir>/.lite-agent/agents`) and a file named `general-purpose` overrides the built-in. Each subagent runs in an isolated, persisted (`agent-<id>.jsonl`), resumable session, shares the project task list, and runs under a lenient permission posture by default (the OS sandbox still applies). New `createLiteAgent`/`query` options `agents` (default on), `agentsDir`, and `subagentPermission`.
- 29f09a8: Replace the in-memory `todo` tool with a persistent Tasks API (`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`): one JSON file per task under `tasks/<listId>/`, bidirectional dependencies with cycle detection, cross-process file locking, and a per-turn `<system-reminder>` that re-injects the current task list without persisting it. New `createLiteAgent`/`query` options `tasks` (default on) and `taskListId`.

### Patch Changes

- Updated dependencies [94e4e45]
- Updated dependencies [b30b419]
- Updated dependencies [29f09a8]
  - @lite-agent/core@0.3.0

## 0.2.0

### Minor Changes

- 7ce80b8: feat(sdk): `.lite-agent` home, default persistence, and age-based cleanup

  `createLiteAgent`/`query` adopt a Claude Code–style home (`$LITE_AGENT_HOME` || `~/.lite-agent`) and turn persistence on by default (all opt-out). This is a behavior change: `createLiteAgent`/`query` now write to disk and sweep stale files by default.

  - **Paths** (`resolveProjectPaths` / `liteAgentHome` / `projectHash`): per-project runtime artifacts under `~/.lite-agent/projects/<sha1(workdir)>/{spill,sessions}`; global skills under `~/.lite-agent/skills`; project skills under `<workdir>/.lite-agent/skills`.
  - **Skills**: loaded from global < project < explicit `skillsDir` (later overrides earlier). `SkillLoader`'s constructor now accepts `string | string[]`, and its public `skillsDir` field was renamed to `dirs` (no external consumer in-repo; pre-1.0).
  - **Defaults** (each overridable): `sessions` → `jsonlStore`, `spill` → `fileSpillStore` + `read_spilled`, `compactor` → deterministic `defaultCompactor` (no LLM), `cleanup` → `sweepStale` (30-day sweep). Opt out via `sessions:false` / `spill:false` / `compactor:false` / `cleanup:false`; an explicit `store`/`compactor` overrides the default. New `home?` option overrides the home for both `createLiteAgent` and `query`.

  > Note: cleanup sweeps by file mtime at startup. Resuming a session whose transcript has been untouched for longer than the cleanup window (30 days by default) will have that transcript swept before it loads, so its history is dropped. Active sessions bump their mtime each turn and are never at risk; raise `cleanup.maxAgeDays` or set `cleanup:false` to keep cold transcripts.

  No core changes — built entirely on the existing `Store` / `SpillStore` / `Compactor` strategies.

- b30f11b: feat: session persistence/resume, retry middleware, and context compaction

  P0 capability wave — all additive and opt-in (no breaking changes):

  - **Sessions / resume (P0-2):** `memoryStore()` (core) and `jsonlStore({ dir })` (sdk) implement the `Store` strategy. The kernel now loads a session's transcript at start and persists per tool-turn + at the end. Threaded through `createAgent` / `createLiteAgent` / `query` via a new optional `store`.
  - **Retry (P0-3):** `retry({ maxRetries, backoff, retryOn })` — a `wrapModelCall` middleware that retries transient `ProviderError`s (408/409/425/429/5xx + network), and never re-runs after output has started streaming.
  - **Context compaction (P0-1):** `core/src/compaction/` — composable `CompactPass` bricks (`snipPass` turn-aware middle-drop, `microPass` tool_result shrink) wired through `runPipeline` into `defaultCompactor()` (the `Compactor` strategy) and a `compaction()` `beforeModel` middleware; plus `reactiveCompaction()` — an LLM-free `wrapModelCall` safety net that trims and retries on 413 / `prompt_too_long`. `createLiteAgent({ compactor })` wires the proactive + reactive layers together. `llmCompactor()` (L4) is an optional LLM-summary `Compactor` that composes a deterministic base and summarizes older turns once over a token threshold, with a circuit breaker. `toolResultBudgetPass` + `SpillStore` (`memorySpillStore` / `fileSpillStore`) + `readSpilledTool` (L3) move oversized tool-result bodies off-context to disk behind a retrievable `[spilled:ref]` marker; `defaultCompactor({ spillStore })` runs it first in the pipeline.
  - **Kernel:** the model request is now encoded inside the `ModelCall` (so a `wrapModelCall` middleware can mutate `ctx.messages` and retry against the new context), and `ctx.messages` is re-synced after the model call so such mutations land in the result and the store.

### Patch Changes

- b9fb62c: refactor(sdk): parse `SKILL.md` frontmatter with `gray-matter`

  `SkillLoader` now uses the `gray-matter` library instead of a hand-rolled line splitter, so skill frontmatter is parsed as real YAML (arrays, quoted values, nested keys) rather than flat `key: value` strings.

- Updated dependencies [b30f11b]
  - @lite-agent/core@0.2.0

## 0.1.0

### Minor Changes

- ce5c1e8: Initial 0.1.0 release of the pluggable agent-core SDK.

  - **@lite-agent/core** — event-driven kernel, strategy interfaces (provider/codec/tool/compactor/permission/approval/input/sandbox/store), onion middleware pipeline, normalized types, native codec, `policy()` + `permission()` gate.
  - **@lite-agent/provider** — Anthropic Messages API + OpenAI Chat Completions providers in one package (OpenAI also works with OpenAI-compatible / local endpoints). The example picks the provider by detecting the protocol from `LITE_AGENT_MODEL_ID`.
  - **lite-agent** — batteries layer: `createLiteAgent`/`query`, bash/file/todo + `ask_user` tools, skills loader, system prompt.
  - **@lite-agent/sandbox-anthropic** — OS-level sandbox adapter with graceful degradation.

- v0.1.0

### Patch Changes

- Updated dependencies [ce5c1e8]
- Updated dependencies
  - @lite-agent/core@0.1.0
