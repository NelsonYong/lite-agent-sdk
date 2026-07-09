# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

lite-agent is a **pluggable, lightweight agent-core SDK**, structured as a pnpm monorepo. The kernel is provider-agnostic and built from swappable strategy interfaces + an onion middleware pipeline + a typed event stream. Its public API is shaped after `@anthropic-ai/Codex-agent-sdk` (`query` / `tool` / `allowedTools`), but the kernel is self-built so it can also drive local small models via pluggable tool-call codecs. The API design references that SDK; the Anthropic **provider** wraps the raw `@anthropic-ai/sdk` Messages API.

## Layout

```
packages/                     # published SDK packages (fixed-versioned together)
  core/                       # @lite-agent/core  — kernel, strategies, middleware, types, codecs, permission, sandbox
  provider/                   # @lite-agent/provider — Anthropic + OpenAI ModelProviders (src/anthropic, src/openai)
  sdk/                        # lite-agent — batteries: tools, skills, system prompt, createLiteAgent / query
  sandbox-anthropic/          # @lite-agent/sandbox-anthropic — OS-level Sandbox adapter (sandbox-runtime)
examples/
  cli/                        # @lite-agent/example-cli (private) — interactive REPL demo; owns its .env + skills/
docs/superpowers/             # specs/ (design docs) + plans/ (TDD implementation plans)
.changeset/                   # changesets config + pending changelogs
```

## Commands

Run from the repo root (it is a **private workspace root** — orchestration only):

- **Build all:** `pnpm build` → `pnpm -r build` (each package: `tsup` → `dist/` ESM + d.ts)
- **Test all:** `pnpm test` → `pnpm -r test` (vitest)
- **Typecheck all:** `pnpm typecheck` → `pnpm -r typecheck` (`tsc --noEmit`)
- **Run the demo:** `pnpm dev` → `pnpm --filter @lite-agent/example-cli dev` (`tsx src/main.ts`)
- **One package:** `pnpm --filter @lite-agent/<name> <test|build|typecheck>` (the SDK package is unscoped: `pnpm --filter lite-agent …`) · single test: `pnpm --filter @lite-agent/core test -- <namefilter>`
- **Versioning:** `pnpm changeset` (describe a change) → `pnpm version` (bump + changelogs) → `pnpm release` (build + `changeset publish`; publish wired, not yet run)
- **Package manager:** pnpm (pinned 10.12.4). Node >= 20.

> **Build-before-test choreography (non-obvious):** packages import each other via their **built `dist/`** (package.json `exports` → `./dist/index.js`; `dist` is git-ignored, no src alias). So changing a package's source and then testing/typechecking a _dependent_ package (or the example) reads **stale dist** unless you rebuild the changed package first. Safe full check: `pnpm -r build && pnpm -r test && pnpm -r typecheck`. `pnpm -r` builds in topological order.

The example reads config from `examples/cli/.env` (see `.env.example`): `ANTHROPIC_API_KEY`, `BASE_URL`, `MODEL_ID`, optional `MONITOR_PORT`.

## Architecture

### Kernel (`core/src/kernel.ts`)

`runKernel(cfg, input, signal, sessionId)` is an `async function*` yielding `AgentEvent`s and returning a `RunResult`. Each turn: `codec.encode` the request → `provider.stream` (wrapped by `wrapModelCall` middleware) → accumulate text/usage → `codec.decode` the assistant message into tool calls → for each call run `composeToolCall` (the `wrapToolCall` middleware chain) around `tool.execute` → push tool results back as a user message → loop until the model stops calling tools or `maxTurns`. Abort is observed at turn boundaries. The kernel knows nothing about permissions, sandboxing, or compaction — those are middleware/strategies.

**Event queue:** middleware/tools `emit()` into an internal queue that is **drained between steps** (`yield* drain()`), so events are _observational_ — e.g. an `approval_request` event is seen only after `approval.request()` has already resolved. Interactive handlers (`ApprovalHandler`, `InputHandler`) do their own blocking I/O; the events are for logging/UI.

### Nine pluggable strategies (`core/src/strategies.ts`)

`ModelProvider` · `ToolCallCodec` · `Tool` · `Compactor` · `PermissionPolicy` · `ApprovalHandler` · `InputHandler` · `Store` · `Sandbox`. Each is "one implementation per role, swappable." `ToolContext` (handed to `tool.execute`) carries `sessionId`, `signal`, `emit`, plus optional `approval` / `input` / `sandbox` / `call` — all provided by the kernel at execution time but typed optional (tools guard).

### Middleware pipeline (`core/src/middleware.ts`)

Onion model. `Middleware` may implement `beforeAgent` / `afterAgent` / `beforeModel` (lifecycle), `wrapModelCall` (retry/cache around the stream), and `wrapToolCall` (gate/time/short-circuit a single tool). `composeModelCall` / `composeToolCall` fold the array outer→inner. The `permission()` gate is a `wrapToolCall` middleware (see below).

### Normalized types + events (`core/src/types.ts`, `events.ts`)

Provider-agnostic `Message` / `ContentBlock` / `ToolCall` / `ToolResult` / `UserQuestion` / `UserAnswer`. The `AgentEvent` union covers `turn_start`, `text_delta`, `message`, `tool_use`, `approval_request|resolved`, `input_request|resolved`, `tool_result`, `compaction`, `turn_end`, `error`, `done`. Error classes: `AgentError` + `ProviderError(status)` / `ToolError` / `CodecError` / `MaxTurnsError` / `AbortError`.

### Permission gate (`core/src/permission.ts`)

`policy({ allow, ask, deny, default })` → a `PermissionPolicy` matching **tool name** by glob (`*`), precedence **deny > ask > allow**, unmatched → `default` (`"allow"`). `permission(policy, approval?)` is the gate middleware: `allow` → run; `deny` → `isError` result, tool never runs; `ask` → emit `approval_request` → `await approval.request()` (fail-closed `deny` if no handler) → emit `approval_resolved` → run or deny.

### Sandbox (`core/src/sandbox.ts`, `@lite-agent/sandbox-anthropic`)

`Sandbox.wrap(command, {cwd})` rewrites a shell command to run inside an OS boundary. Default `noopSandbox()` (no boundary). `sandboxRuntime(opts)` wraps `@anthropic-ai/sandbox-runtime` (macOS Seatbelt / Linux bubblewrap); on an unsupported env it **degrades to noop** (unless `requireSandbox: true`) and fires `onUnavailable` once. `bashTool` wraps its command via `ctx.sandbox` before `execSync`. Sandbox (runtime boundary) + permission gate (pre-exec decision) = defense-in-depth.

### SDK batteries (`lite-agent`)

`createLiteAgent(cfg)` assembles `defaultTools` (bash/file) + task tools + skills + a built system prompt + a `nativeCodec` agent, prepending the `permission()` middleware when `permission` is set, registering `ask_user` only when `onAskUser` is set, and threading `sandbox` / `onApproval` / `onAskUser`. `query(opts)` is the Codex-agent-sdk-style facade over it. `tool(name, desc, schema, handler)` defines a tool; `ask_user` (`tools/askUser.ts`) emits `input_request` → `await ctx.input.request` → `input_resolved`. Skills load from a `skillsDir` of `SKILL.md` files (YAML frontmatter); `load_skill` injects a body on demand. Subagents: a parallel-capable `Agent` dispatch tool (default on; `agents:false` disables) whose children run isolated, persisted, resumable sessions and share the project task list. A built-in `general-purpose` agent is always seeded, so delegation works with no config; specialized agents load from `agents/*.md` (global `~/.lite-agent/agents` + project `<workdir>/.lite-agent/agents`) and override the built-in by name. `createLiteAgent` returns a `LiteAgent` that owns a current session: `run`/`send` default to it, and `resume(id)` / `clear()` / `deleteSession(id)` / `listSessions()` / `sessionId` manage it. The default session id is unique per agent (not a process-local counter), and the default `jsonlStore` is a `SessionStore` (supports `list`/`delete`).

### Providers (`@lite-agent/provider`)

One package ships two `ModelProvider`s. `anthropic(opts)` (`src/anthropic/`) maps normalized requests → Anthropic Messages API; `openai(opts)` (`src/openai/`) maps them → OpenAI Chat Completions (also works against OpenAI-compatible / local endpoints). Each subfolder pairs a `mapping.ts` (request → provider params) with a `stream.ts` (provider SSE → `ModelChunk`s), wraps SDK errors in `ProviderError` preserving `.status`, and exposes an injectable client seam for offline tests. The package root re-exports both `anthropic` and `openai`.

## Design discipline (enforced in the specs)

**Strategy** = replace one part (provider, codec, compaction, approval/input UI, store, sandbox). **Middleware** = add a stackable cross-cutting layer (permission, retry, logging, rate-limit). **Event** = observe only (logging, UI, metrics). Mnemonic: swap a part → strategy; add a layer → middleware; only watch → event. Design specs and TDD plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Tech / tooling

- TypeScript 6 (strict, ES2022, ESM). Shared `tsconfig.base.json` uses `moduleResolution: Bundler`, `verbatimModuleSyntax` (type-only imports need `import type`), `noUncheckedIndexedAccess`, **no** `esModuleInterop`. The example app uses its own `NodeNext` tsconfig.
- **`tsconfig.build.json` per package** adds `ignoreDeprecations: "6.0"` (the tsup `--dts` worker injects deprecated `baseUrl`); it is kept out of the editor-facing base config and referenced via `tsup --tsconfig`.
- Build: `tsup` (ESM + d.ts). Test: `vitest`; kernel tests use `fakeProvider` + golden event-stream assertions, and mock external modules with `vi.mock`. Validation: `zod` (tool schemas → JSON Schema). Versioning: `changesets` (the four published packages — `lite-agent` + `@lite-agent/{core,provider,sandbox-anthropic}` — are **fixed**: one shared version; the example is ignored).
