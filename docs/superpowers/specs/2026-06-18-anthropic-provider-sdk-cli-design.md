# Anthropic Provider + SDK + CLI Slice — Design

> Vertical slice on top of the approved Agent Core SDK design
> ([2026-06-18-agent-core-sdk-design.md](./2026-06-18-agent-core-sdk-design.md)).
> Delivers the first end-to-end runnable CLI: real Anthropic API, default tools, skills.

**Status:** Approved (design confirmed in chat: "老代码都去掉,provider 先做 Anthropic" / "设计合理";
API 对标 `@anthropic-ai/claude-agent-sdk`).

## Two distinct "Claude SDKs" — do not conflate

| Package | What it is | Role here |
| --- | --- | --- |
| `@anthropic-ai/sdk` | Raw **model API** client (Messages API, token streaming) | The thing `provider-anthropic` wraps — the only way a `ModelProvider` emits tokens |
| `@anthropic-ai/claude-agent-sdk` | Anthropic's high-level **Agent SDK** (`query()` loop, `tool()`, permissions, hooks, MCP) | A **peer** to `@lite-agent-sdk/core` + `lite-agent-sdk`, used as an **API-design reference**, NOT a dependency |

We do **not** build the provider on `claude-agent-sdk`: it only talks to Anthropic and bundles its
own agent loop, which would break the "run local small models" and "lean pluggable kernel" goals.
Instead `lite-agent-sdk`'s public API is shaped after `claude-agent-sdk` so it feels familiar.

## Goal

Turn the completed `@lite-agent-sdk/core` (Phase 1) into something a user can actually run:

1. `@lite-agent-sdk/provider` — a real `ModelProvider` adapting `@anthropic-ai/sdk` streaming.
2. `lite-agent-sdk` — a batteries-included layer: default tools (bash/file/todo), skill loading, and a `createLiteAgent` factory.
3. The outer `src/` rewritten as a CLI app consuming `lite-agent-sdk`, with **all old demo code removed**.

## Non-Goals (deferred to later phases)

- Human approval / whitelist permission policy (Phase 3).
- `ask_user` elicitation wiring (Phase 3).
- Two-stage compaction (Phase 4).
- Durable sessions / `Store` (Phase 4) — the CLI keeps history in memory.
- OpenAI-compatible provider, local-model json/react codecs (later).
- Re-expressing team/worktree/background/monitor as plugins (later or dropped).

## Architecture

Three layers, dependencies point downward:

```
outer src/ (CLI app)        ── consumes ──▶  lite-agent-sdk
lite-agent-sdk             ── consumes ──▶  @lite-agent-sdk/core
@lite-agent-sdk/provider ── consumes ─▶ @lite-agent-sdk/core + @anthropic-ai/sdk
```

The CLI wires a provider + the SDK together; neither package knows about the other.

### 1. `@lite-agent-sdk/provider`

`anthropic(opts?): ModelProvider` where `opts = { apiKey?, baseURL?, client? }`.

- `id = "anthropic"`. The **model name is not stored here** — it flows in via
  `ModelRequest.model` (the core kernel sets `req.model = cfg.modelName ?? provider.id`,
  so the app passes `modelName` from `MODEL_ID`).
- `apiKey` defaults to `process.env.ANTHROPIC_API_KEY`; `baseURL` to `process.env.BASE_URL`.
- `opts.client` allows injecting a fake SDK client for tests (no network).

Two responsibilities, split into pure functions for testability:

- **Request mapping** (`mapping.ts`): `toAnthropicParams(req: ModelRequest)` →
  Anthropic `MessageCreateParams`. `system` → top-level `system`; `messages` (excluding
  any `system` role) → Anthropic messages; our `ContentBlock`s → Anthropic blocks
  (`text` / `tool_use` / `tool_result`); `ToolSpec{name,description,parameters}` →
  `{name, description, input_schema}` (strip the `$schema` key zod emits);
  `maxTokens ?? 4096` (Anthropic requires `max_tokens`).
- **Stream translation** (`stream.ts`): `translateStream(events)` consumes the SDK's
  `RawMessageStreamEvent` async-iterable and yields normalized `ModelChunk`s — `text_delta`
  per text delta, and a final `message_done` carrying the assembled `AssistantMessage`
  (normalized `text` + `tool_call` blocks) and `Usage` (`input_tokens` from `message_start`,
  `output_tokens` from the last `message_delta`).

`stream(req, signal)` = `translateStream(client.messages.create({ ...toAnthropicParams(req), stream: true }, { signal }))`.

### 2. `lite-agent-sdk`

- **Default tools** (`Tool` + zod schema, ported from the old demo, console logging removed —
  the app renders events instead):
  - `bashTool(workdir)` — `execSync` with `cwd: workdir`, dangerous-command filter, 120s timeout.
  - `readFileTool/writeFileTool/editFileTool(workdir)` — each closes over a `safePath` bound to
    `workdir` (workspace confinement) and the 50KB read cap.
  - `todoTool()` — closes over a fresh in-memory `TodoManager` (no global singleton).
  - `defaultTools(workdir)` returns all five.
- **Skills:** `SkillLoader` (ported, no global singleton — constructed by the factory) +
  `loadSkillTool(loader)` returning the skill body by name. Skill **descriptions** are injected
  into the system prompt at construction time (skills are static at startup), so no middleware.
- **System prompt:** `buildSystemPrompt({ workdir, modelName, skills })` — a slim prompt
  (identity, work-in-workdir, todo-planning, skills list + `load_skill` hint). The old
  team/subagent sections are dropped.
- **Factory:** `createLiteAgent(cfg)` wires `nativeCodec` + default tools + optional
  `load_skill` + system prompt and returns a core `Agent` (the reusable handle the CLI keeps
  across turns):

  ```ts
  createLiteAgent({
    model: ModelProvider; modelName?: string; workdir: string;
    skillsDir?: string; tools?: Tool[]; system?: string;
    allowedTools?: string[]; disallowedTools?: string[];
    maxTurns?: number; maxTokens?: number; use?: Middleware[];
  }): Agent
  ```

#### API shaped after `claude-agent-sdk`

To feel familiar to `claude-agent-sdk` users, `lite-agent-sdk` also exports:

- **`query(opts): AsyncGenerator<AgentEvent, RunResult>`** — a one-shot facade mirroring
  `claude-agent-sdk`'s `query({ prompt, options })`. `opts = { prompt, model, modelName?, cwd?,
  systemPrompt?, allowedTools?, disallowedTools?, tools?, skillsDir?, maxTurns?, maxTokens?,
  use?, signal?, sessionId? }`. Internally: `createLiteAgent({...}).run(prompt, { signal, sessionId })`.
  (`cwd` maps to `workdir`, `systemPrompt` to `system`.)
- **`tool(name, description, schema, handler)`** — a positional helper matching
  `claude-agent-sdk`'s `tool(...)`, returning a core `Tool` (thin wrapper over `defineTool`).
- **`allowedTools` / `disallowedTools`** — in this slice implemented as a **registration filter**
  (which tools are exposed by name), not a permission gate. Filter order: start from
  `[...defaultTools, loadSkill?, ...extraTools]`; if `allowedTools` is set keep only those names;
  then drop any in `disallowedTools`.

**Deferred to Phase 3** (named here so the surface is forward-compatible): `canUseTool`,
`permissionMode`, `hooks`, `systemPrompt` presets, `mcpServers`. The middleware pipeline already
covers what `hooks` would do.

`lite-agent-sdk` re-exports `@lite-agent-sdk/core` (`export * from "@lite-agent-sdk/core"`) so apps depend
on one package for both the batteries and the core types (`Message`, `AgentEvent`, `Agent`, ...).

### 3. Outer `src/` CLI app

- Removed: `src/agent/`, `src/tools/`, `src/prompt/`, `src/monitor.ts`; `src/main.ts` rewritten.
- `main.ts`: load `.env` → `anthropic()` provider → `createLiteAgent({ model, modelName: MODEL_ID,
  workdir: cwd, skillsDir: <cwd>/skills })` → REPL.
- **Multi-turn** without a `Store`: the app keeps `history: Message[]`. Each turn pushes the user
  message, drives `agent.run(history, { signal, sessionId })`, renders events, and sets
  `history = result.messages` (the generator's return value).
- **Event rendering:** `text_delta` → stream to stdout; `tool_use` → print `name(input)`;
  `tool_result` → print truncated content; `error` → print.
- **ESC interrupt** via raw-mode key listener → `AbortController` (ported from the old `main.ts`).
- Multi-line paste detection ported. `q`/`exit` quits.
- Root `package.json`: depend on the two workspace packages; `dev` stays `tsx src/main.ts`.

## Error Handling

- Tool errors are already caught by the kernel and returned as `isError` tool results.
- Provider errors surface as thrown `ProviderError` from the stream (the provider wraps raw
  `@anthropic-ai/sdk` errors, preserving HTTP `status`); the CLI try/catches around the run loop and
  prints, then returns to the prompt.
- In Phase 2 fatal errors **throw** (propagate out of `agent.run()`) rather than being emitted as an
  `error` AgentEvent. The CLI's `error`-event render branch is forward-compatible surface for a later
  phase where the kernel may emit a non-fatal `error` event before throwing; it is unreachable today.
- `safePath` throws on escape; the file tool's own try/catch turns it into an error string.

## Testing

- **provider mapping** (`mapping.test.ts`): pure — assert `toAnthropicParams` shape (system hoist,
  block translation, tool `input_schema`, `$schema` stripped, `max_tokens` default).
- **provider stream** (`stream.test.ts`): feed a hand-built async iterable of fake
  `RawMessageStreamEvent`s into `translateStream`; assert `text_delta` chunks and the final
  `message_done` (assembled blocks + usage). No network.
- **sdk tools** (`tools.test.ts`): `safePath` confinement, bash dangerous-command block, todo render.
- **sdk factory** (`createLiteAgent.test.ts`): with `fakeProvider`, assert the agent runs and that
  default tools + `load_skill` + skill descriptions are wired (a skill-listing in `system`, a
  `load_skill` call resolves); assert `allowedTools`/`disallowedTools` filter the registered set.
- **sdk facade** (`query.test.ts`): with `fakeProvider`, assert `query({ prompt, model, ... })`
  streams the same events as `createLiteAgent().run()`; assert `tool(name, desc, schema, handler)`
  produces a working `Tool`.
- **app**: smoke only (constructs without throwing); real conversation verified manually via `.env`.

## Sequencing

1. Workspace scaffolding for the two new packages.
2. `@lite-agent-sdk/provider` (mapping → stream → provider) — TDD.
3. `lite-agent-sdk` (tools → skills → system → factory) — TDD.
4. Rewrite outer `src/` CLI; remove old code; update root `package.json`.
5. End-to-end manual smoke (user runs `pnpm dev` with `.env`).
