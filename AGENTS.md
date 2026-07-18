# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

lite-agent is a **pluggable, lightweight agent-core SDK**, structured as a pnpm monorepo. The kernel is provider-agnostic and built from swappable strategy interfaces + an onion middleware pipeline + a typed event stream. Its public API is shaped after `@anthropic-ai/Codex-agent-sdk` (`query` / `tool` / `allowedTools`), but the kernel is self-built so it can also drive local small models via pluggable tool-call codecs. The API design references that SDK; the Anthropic **provider** wraps the raw `@anthropic-ai/sdk` Messages API.

## Layout

```
packages/                     # published SDK packages (versioned per changed package)
  core/                       # @lite-agent/core  — kernel, strategies, middleware, types, codecs, permission, sandbox
  provider/                   # @lite-agent/provider — Anthropic + OpenAI ModelProviders (src/anthropic, src/openai)
  sdk/                        # @lite-agent/sdk — batteries: tools, skills, system prompt, createLiteAgent / query
  sandbox-anthropic/          # @lite-agent/sandbox-anthropic — OS-level Sandbox adapter (sandbox-runtime)
  checkpoint-sqlite/          # @lite-agent/checkpoint-sqlite — SQLite WAL event checkpointer
  local/                      # @lite-agent/local — strict single-host local-model/runtime assembly
examples/
  cli/                        # @lite-agent/example-cli (private) — interactive REPL demo; owns its .env + skills/
docs-site/                    # @lite-agent/docs (private) — Rspress bilingual docs site → GitHub Pages
docs/superpowers/             # specs/ (design docs) + plans/ (TDD implementation plans)
```

## Commands

Run from the repo root (it is a **private workspace root** — orchestration only):

- **Build all:** `pnpm build` → `pnpm -r build` (each package: `tsup` → `dist/` ESM + d.ts)
- **Test all:** `pnpm test` → `pnpm -r test` (vitest)
- **Typecheck all:** `pnpm typecheck` → `pnpm -r typecheck` (`tsc --noEmit`)
- **Run the demo:** `pnpm dev` → `pnpm --filter @lite-agent/example-cli dev` (`tsx src/main.ts`)
- **Docs site:** `pnpm docs:dev` / `pnpm docs:build` / `pnpm docs:preview` → `pnpm --filter @lite-agent/docs <dev|build|preview>` (Rspress; build output `docs-site/doc_build`, base from `DOCS_BASE`). Deployed via `.github/workflows/deploy-docs.yml` on pushes to `main` touching `docs-site/**`.
- **One package:** `pnpm --filter @lite-agent/<name> <test|build|typecheck>` · single test: `pnpm --filter @lite-agent/core test -- <namefilter>`
- **Versioning:** update changed package versions + English `CHANGELOG.md` files manually; `pnpm release:changed` previews registry publishing and `--yes` publishes.
- **Package manager:** pnpm (pinned 10.12.4). Node >= 20.

> **Build-before-test choreography (non-obvious):** packages import each other via their **built `dist/`** (package.json `exports` → `./dist/index.js`; `dist` is git-ignored, no src alias). So changing a package's source and then testing/typechecking a _dependent_ package (or the example) reads **stale dist** unless you rebuild the changed package first. Safe full check: `pnpm -r build && pnpm -r test && pnpm -r typecheck`. `pnpm -r` builds in topological order.

The example reads config from `examples/cli/.env` (see `.env.example`): `LITE_AGENT_MODEL_ID`, `LITE_AGENT_MODEL_API_KEY`, `LITE_AGENT_BASE_URL`, optional `LITE_AGENT_MODEL_PROTOCOL`.

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

### SDK batteries (`@lite-agent/sdk`)

`createLiteAgent(cfg)` assembles `defaultTools` (bash/file) + task tools + skills + a built system prompt + a configurable codec (default `nativeCodec`), prepending the `permission()` middleware when `permission` is set, registering `ask_user` only when `onAskUser` is set, and threading sandbox, checkpoint, recovery, context-budget, and resource options. `query(opts)` is the agent-sdk-style facade over it. `tool(name, desc, schema, handler, opts?)` defines a tool and optional security metadata. Skills load from `SKILL.md` files; subagents are parallel-capable, isolated sessions. `createLiteAgent` owns a current session with `resume`/`clear`/`deleteSession`/`listSessions`; the default backend is the event-sourced file checkpointer.

### Strict local assembly (`@lite-agent/local`)

`createLocalAgent()` is the async, fail-closed single-host entry point. It requires a declared loopback/Unix-socket provider and assembles SQLite WAL, mandatory sandbox initialization, resource limits, deny-by-default reloadable permission files, durable permission audit, safe interrupted-tool recovery, context-budget compaction, and a rotating redacted hash-chained event sink. `localOpenAI()` provides Ollama/vLLM/LM Studio/llama.cpp presets; unknown custom tools must declare `Tool.security`.

### Providers (`@lite-agent/provider`)

One package ships two `ModelProvider`s. `anthropic(opts)` (`src/anthropic/`) maps normalized requests → Anthropic Messages API; `openai(opts)` (`src/openai/`) maps them → OpenAI Chat Completions (also works against OpenAI-compatible / local endpoints). Each subfolder pairs a `mapping.ts` (request → provider params) with a `stream.ts` (provider SSE → `ModelChunk`s), wraps SDK errors in `ProviderError` preserving `.status`, and exposes an injectable client seam for offline tests. The package root re-exports both `anthropic` and `openai`.

## Design discipline (enforced in the specs)

**Strategy** = replace one part (provider, codec, compaction, approval/input UI, store, sandbox). **Middleware** = add a stackable cross-cutting layer (permission, retry, logging, rate-limit). **Event** = observe only (logging, UI, metrics). Mnemonic: swap a part → strategy; add a layer → middleware; only watch → event. Design specs and TDD plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Tech / tooling

- TypeScript 6 (strict, ES2022, ESM). Shared `tsconfig.base.json` uses `moduleResolution: Bundler`, `verbatimModuleSyntax` (type-only imports need `import type`), `noUncheckedIndexedAccess`, **no** `esModuleInterop`. The example app uses its own `NodeNext` tsconfig.
- **`tsconfig.build.json` per package** adds `ignoreDeprecations: "6.0"` (the tsup `--dts` worker injects deprecated `baseUrl`); it is kept out of the editor-facing base config and referenced via `tsup --tsconfig`.
- Build: `tsup` (ESM + d.ts). Test: `vitest`; kernel tests use `fakeProvider` + golden event-stream assertions, and mock external modules with `vi.mock`. Validation: `zod` (tool schemas → JSON Schema). Versioning is manual and only changed published packages are bumped.
