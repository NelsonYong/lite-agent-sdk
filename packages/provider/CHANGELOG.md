# @lite-agent/provider

## 0.7.0

### Patch Changes

- Updated dependencies [2d0e4b9]
- Updated dependencies [795c10d]
  - @lite-agent/core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [a2d41fd]
- Updated dependencies [d39189e]
- Updated dependencies [33d9c4e]
  - @lite-agent/core@0.6.0

## 0.5.2

### Patch Changes

- @lite-agent/core@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies
  - @lite-agent/core@0.5.1

## 0.5.0

### Minor Changes

- fefb68f: Add model sampling and tool-selection controls

  `ModelRequest` gains `temperature`, `topP`, `toolChoice`, and `seed`, threaded through
  `KernelConfig` → `createAgent` → `createLiteAgent` / `query` (and inherited by subagents).
  `toolChoice` is normalized as `"auto" | "none" | "required" | { tool: string }`.

  Both providers forward the new fields: the OpenAI mapping emits `temperature` / `top_p` /
  `seed` / `tool_choice`; the Anthropic mapping emits `temperature` / `top_p` and maps
  `tool_choice` to its `auto` / `none` / `any` / `tool` shapes (`seed` is unsupported by
  Anthropic and intentionally ignored). `tool_choice` is only sent when tools are present.

- 4681f1e: Stop the providers from double-retrying

  `openai()` and `anthropic()` now construct their SDK clients with `maxRetries: 0` by
  default, and expose a `maxRetries` option. Previously each SDK retried transient
  failures twice on its own, which **compounded** with the `retry()` middleware
  (≈ 3 × 3 connection attempts and inflated backoff latency). Retry policy now has a
  single owner — the `retry()` middleware — and `maxRetries` lets you restore
  SDK-level retries when not using the middleware.

### Patch Changes

- Updated dependencies [c695991]
- Updated dependencies [fefb68f]
- Updated dependencies [c99328b]
  - @lite-agent/core@0.5.0

## 0.4.0

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

### Patch Changes

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
