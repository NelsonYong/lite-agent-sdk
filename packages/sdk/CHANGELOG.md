# lite-agent

## 0.13.0

### Minor Changes

- Move explicitly backgrounded work to session-scoped ownership. `run()` and
  `send()` no longer wait for `Agent({ run_in_background: true })` or background
  Bash work; the originating session is automatically woken when work completes.

- Add `LiteAgent.subscribe()` for continuous user/background event delivery and
  `LiteAgent.close()` for explicit background-task cleanup. Ordinary `Agent`
  calls remain blocking by default, and one-shot `query()` closes temporary work.

## 0.12.2

## 0.12.1

## 0.12.0

### Minor Changes

- Add automatic context management to `createLiteAgent()` and `query()` through
  the new `context` option. The SDK now wires the core `ContextEngine`, stores
  archived historical context via `fileContextArchive()`, exposes the
  bounded-data `context` lookup tool, and exports `ContextOptions`,
  `sessionContextDir()`, `contextLookupTool()`, and related archive types.

### Patch Changes

- Refactor `createLiteAgent()` into a thin composition root backed by internal
  assembly and session facade modules. Public APIs and runtime behavior are
  unchanged, while the construction path is easier to maintain and extend.

## 0.11.0

### Minor Changes

- Add configurable codecs, decode repair, context budgets, crash recovery,
  snapshot quotas, background limits and bash runtime limits to
  `createLiteAgent()` / `query()`. `tool()` now accepts optional security
  metadata, while existing defaults remain backward compatible.

- Harden file operations and restore. `write_file` / `edit_file` use atomic
  same-directory replacement, canonical path checks prevent symlink escapes,
  and UTF-8/base64 snapshots restore deleted or overwritten binary files exactly.
  The default tool set now includes checkpoint-aware `delete_file`.

- Add reloadable deny-by-default permission files and a rotating local event
  sink. `permissionFilePolicy()` merges managed, user, project and inline rules
  with global deny precedence; `jsonlEventSink()` redacts records and protects
  them with SHA-256 or HMAC hash chains.

### Patch Changes

- File checkpointers can fsync appends and repair one malformed trailing record;
  cleanup can enforce an LRU byte limit across session and spill files.

## 0.10.0

### Minor Changes

- Make background shell commands detached and pollable. `bash` with
  `run_in_background: true` now starts a streaming child process that does not
  block run completion; read incremental output through the new `BashOutput` tool
  and stop it with `KillBackground`. `BashOutput` is registered by default with
  background support and omitted when `background: false`.

- Change the `Agent` subagent tool back to blocking by default. Calls now return
  aggregated subagent results inline unless `run_in_background: true` is passed,
  in which case the subagent batch is a joinable background task and its results
  arrive later as a notification.

- Add SDK permission helpers and gate options. New `bashCommand()` and `filePath()`
  helpers build content-level `PermissionRule`s, and `createLiteAgent()` / `query()`
  now forward `redact` and `permissionMode` to the core permission middleware so
  callers can customize audit redaction or run policies in dry-run mode.

## 0.9.0

### Minor Changes

- Add non-blocking background execution (Claude Code's `run_in_background`), gated by a new top-level `background` option on `createLiteAgent` / `query` (default on):
  - **`bash` gains `run_in_background` (default `false` — foreground behavior is unchanged).** A backgrounded command runs via async `exec` (not `execSync`, which would block the event loop), is bounded by cancellation rather than the 120s foreground timeout (so it suits long-running servers / watchers), and its output is delivered to the agent as a notification when it finishes.
  - **Behavioral change: the `Agent` subagent tool now defaults to `run_in_background: true`.** An `Agent` call returns a placeholder immediately, and the aggregated `subagent[…]` results arrive later as a single notification once all children finish — instead of blocking and returning them inline. Pass `run_in_background: false` to restore the old synchronous behavior. Callers that relied on `Agent` returning its results inline must set the flag.
  - New `KillBackground` tool cancels a running background task by its reported `bg_…` id. It is registered by default and omitted when `background: false`.

  Under the hood a run stays alive until every background task it spawned has finished (delivered as `<background-task-completed>` notifications), and background subagent events are routed to the run-level event stream so they still surface after the spawning turn ends.

## 0.8.2

### Patch Changes

- Docs: add a package README (English + Simplified Chinese) documenting `query` / `createLiteAgent` / `tool`, the built-in batteries (default tools, skills, subagents, tasks, sessions, compaction, permission gate, sandbox, `ask_user`, structured output), and session management. Also correct `repository.url` to the renamed `lite-agent-sdk` GitHub repository. No code changes.

## 0.8.1

### Patch Changes

- `read_file` and `edit_file` now return an actionable error when a path doesn't exist, instead of a raw `ENOENT`. The message names the first path segment that is missing, lists the nearest existing directory, and — via a bounded workspace search — suggests same-named files elsewhere (e.g. asking for `extension/src/agent/forge-agent.ts` points you to `src/agent/forge-agent.ts`), so the model can correct a wrong path in one step. Path resolution is unchanged; `write_file` is unaffected (it still creates parent directories).

## 0.8.0

### Minor Changes

- afbb084: Add free-text steering to manual compaction. `LiteAgent.compact(instructions?)` forwards an instruction string to the compactor (Claude Code's `/compact <instructions>`), biasing the summary toward what should be preserved. Only a manual `compact()` forwards it; automatic compaction is unchanged.

### Patch Changes

- c0384f5: Generate session ids as UUID v4 (e.g. `be63a577-971d-4a42-a8fe-a572b7246431`) via `crypto.randomUUID()`, replacing the `s-<timestamp>-<rand>` form. Ids stay opaque strings, so previously created sessions still resume/restore.

## 0.7.0

### Minor Changes

- 2d0e4b9: Add a manual, durable compaction action. `LiteAgent.compact()` compresses the current session's conversation using the configured compactor, persists the result as a new `summary` event (so it survives reloads and composes with restore), emits `compaction` progress + completion events, then stops — it never produces a model answer. `foldEvents` now treats `summary` as a base reset, so loading a compacted session uses the compressed view with no kernel change.
- 795c10d: Add session restore. A new `file_snapshot` sidecar event records the pre-mutation content of files changed via `write_file`/`edit_file`; `LiteAgent.restore(id, toSeq, { conversation?, files? })` rolls a session back to a checkpoint — reverting those files and/or truncating the conversation — and `listCheckpoints(id)` enumerates the rewind anchors. `Checkpointer` gains an optional `truncate`. Like Claude Code, files changed by `bash` are not tracked.

### Patch Changes

- Updated dependencies [2d0e4b9]
- Updated dependencies [795c10d]
  - @lite-agent/core@0.7.0

## 0.6.0

### Minor Changes

- d39189e: Stream tool-phase events to consumers in real time (completion order) via an internal push channel, instead of buffering them until the tool pool drains. Subagent events are now forwarded live to the parent event stream, tagged with an optional `agentId` so UIs can route concurrent subagents to their own lanes. The model-facing context is unchanged: tool_result blocks are still assembled in input order and id-matched. Additive — consumers that ignore `agentId` and don't depend on concurrent-tool event ordering are unaffected.
- 33d9c4e: Add turn-boundary steering: a `SteerController` (mirroring `AbortController`) with `steer(msg)` to inject input before the next model turn and `followUp(msg)` to continue a run that would otherwise stop. Pass it via `run`/`query` options (`{ steer }`). Injections surface as an additive `steer` event. No interruption of in-flight model streams. Purely additive — runs without a controller are unchanged.

### Patch Changes

- a2d41fd: Replace hand-rolled internals with maintained libraries: the two concurrency worker-pools (kernel tool pool, Agent subagent pool) now use `p-limit`, and the permission tool-name matcher uses `picomatch` instead of a hand-rolled glob→regexp. Behavior is unchanged for existing tool-name patterns; the permission matcher additionally supports brace (`{a,b}`) and character-class (`[…]`) globs.
- Updated dependencies [a2d41fd]
- Updated dependencies [d39189e]
- Updated dependencies [33d9c4e]
  - @lite-agent/core@0.6.0

## 0.5.2

### Patch Changes

- Subagents dispatched via the `Agent` tool now surface as individual tool calls: each task in a single `Agent` call emits its own `tool_use` + `tool_result` event (paired by id, labeled by `subagent_type`), so a UI renders N distinct subagents instead of one opaque dispatch. The `Agent` description and the subagents prompt now make the synchronous semantics explicit — pass multiple `tasks` in one call to run them in parallel and receive all results together; don't re-invoke the tool to poll for "still running" subagents.
  - @lite-agent/core@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies
  - @lite-agent/core@0.5.1

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
