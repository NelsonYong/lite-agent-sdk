# ContextEngine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the competing compaction/message mutation paths with one session-scoped `ContextEngine` that preserves a byte-stable static prompt prefix, retains high-value facts, applies five internal pressure levels, and exposes only a small `context` option to SDK callers.

**Architecture:** The append-only checkpoint log is the source of truth. A pure projector derives an immutable `ContextView` containing fact pins, working state, selected transcript segments, archive references, and a rendered message list. `ContextEngine` owns serialized append/CAS, pressure policy, optional planner proposals, and view commits; the kernel asks it for a request snapshot and never mutates durable context through middleware. SDK paths derive a session sidecar for archived data and keep legacy compactor/spill options as one-release adapters.

**Tech Stack:** TypeScript 6, ESM, pnpm monorepo, Vitest, existing `Checkpointer`/`ModelProvider`/middleware interfaces, Node filesystem primitives.

## Global Constraints

- The static prefix (system prompt, canonical tool definitions, codec instructions) is protected and must not be rewritten by compaction.
- `SessionEvent` history remains recoverable; a derived view or summary is never the source of truth.
- Public context configuration is only `context?: false | { planner?: { provider: ModelProvider; model: string }; windowTokens?: number }`.
- Five pressure levels are internal policy data, not public classes or thresholds.
- Planner output is additive, provenance-aware, and cannot delete or overwrite fact pins.
- New tool results are not archived until one successful model request has presented them (except emergency overflow handling).
- Use `apply_patch`; preserve the six pre-existing package/changelog modifications; do not add dependencies.
- Every behavior change follows RED → verify failure → minimal GREEN → focused test → full affected-package check.

---

### Task 1: Immutable ContextView projector

**Files:**
- Create: `packages/core/src/context.ts`
- Create: `packages/core/test/context-view.test.ts`
- Modify: `packages/core/src/checkpoint.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes `StoredEvent`, `Message`, `ToolResultBlock`.
- Produces `Fact`, `StateEntry`, `ContextSegment`, `ContextView`, `projectContext(events, options?)`.

- [ ] **Step 1: Write the failing tests** for (a) projection preserving user/assistant/tool pairing and event sequence provenance, (b) a `context_view` event not replacing raw history, (c) fact pins surviving a derived summary, and (d) static-prefix fingerprint changing only when the explicit static input changes.
- [ ] **Step 2: Run `pnpm --filter @lite-agent/core test -- context-view.test.ts` and confirm the missing module/types failure.
- [ ] **Step 3: Implement the smallest pure projector.** Add `context_view` to `SessionEvent` as derived metadata, define immutable readonly types, collect user goals/constraints and verified artifact events into facts, select a recent tail without splitting assistant tool calls from their results, and compute a deterministic SHA-256 prefix fingerprint from canonical system/tools/codec bytes.
- [ ] **Step 4:** Re-run the focused test and then `pnpm --filter @lite-agent/core typecheck`.

### Task 2: Session-scoped ContextEngine and five-level policy

**Files:**
- Create: `packages/core/src/contextEngine.ts`
- Create: `packages/core/test/context-engine.test.ts`
- Modify: `packages/core/src/strategies.ts`
- Modify: `packages/core/src/checkpoint.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- `ContextEngineOptions { sessionId; checkpointer?; provider?; planner?; windowTokens?; staticPrefix }`.
- `ContextEngine.snapshot(input?: Message[]): Promise<ContextView>`.
- `ContextEngine.append(events): Promise<void>`.
- `ContextEngine.presented(generation): Promise<void>`.
- `ContextEngine.compact(reason, instructions?): Promise<ContextView>`.
- `ContextEngine.invalidate(): void`.

- [ ] **Step 1: Add RED tests** for serialized append/CAS, immutable snapshots, no provider call on a stale-head conflict, level-1 externalization only after presentation, level-2 semantic-turn preservation, level-3 planner timeout fallback, and one strictly reducing level-5 retry budget.
- [ ] **Step 2:** Run the focused tests and record the expected RED failures.
- [ ] **Step 3: Add optional provider capabilities (`contextWindow`, `countTokens`, clear/compact edits, prompt-cache metadata) and implement `ContextEngine` with one serialized write chain, deterministic pressure levels, bounded planner invocation, additive proposal validation, and a derived `context_view` append.
- [ ] **Step 4:** Run focused tests, core typecheck, and existing checkpoint/compaction tests; keep old pure passes available only as private helpers/compatibility exports.

### Task 3: Kernel render/append integration

**Files:**
- Modify: `packages/core/src/kernel.ts`
- Modify: `packages/core/src/middleware.ts`
- Modify: `packages/core/src/createAgent.ts`
- Modify: `packages/core/src/events.ts`
- Create: `packages/core/test/kernel-context.test.ts`

**Interfaces:**
- `KernelConfig.context?: ContextEngineOptions` (or a prebuilt engine factory).
- `AgentContext` receives readonly `view` plus request-local suffix support; `messages` is no longer a durable mutable owner.

- [ ] **Step 1: Write RED integration tests** proving system/tools bytes remain identical across normal loops and compaction, middleware cannot mutate the durable view, manual/automatic/overflow paths share one engine, and a context-view CAS conflict skips the model call.
- [ ] **Step 2: Run the focused integration tests and confirm failure against the current `history/messages` owner.
- [ ] **Step 3: Replace kernel-local fold/history/message ownership with engine snapshots; route all event writes through the engine append closure; render request-local steer/background/repair overlays after the protected prefix; invoke `presented()` after a successful model response; emit `context_status`/compaction events.
- [ ] **Step 4: Run kernel regression tests plus `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/core test && pnpm --filter @lite-agent/core typecheck`.

### Task 4: Minimal SDK API and session archive sidecar

**Files:**
- Modify: `packages/sdk/src/liteAgent.ts`
- Modify: `packages/sdk/src/query.ts`
- Modify: `packages/sdk/src/liteAgentAssembly.ts`
- Modify: `packages/sdk/src/paths.ts`
- Modify: `packages/sdk/src/checkpoint.ts`
- Modify: `packages/sdk/src/cleanup.ts`
- Modify: `packages/sdk/src/spill.ts`
- Create: `packages/sdk/src/contextArchive.ts`
- Create: `packages/sdk/test/context-engine.test.ts`
- Modify: `packages/sdk/test/compact.test.ts`
- Modify: `packages/sdk/test/defaults.test.ts`
- Modify: `packages/sdk/test/paths.test.ts`

**Interfaces:**
- `ContextOptions` is the only new public context option.
- `ProjectPaths.contextDir(sessionId)` derives `<session-id>.context/` under the session directory.
- `contextSearchTool(archive)` accepts exactly `{ query?: string; ref?: string }` and returns bounded historical data.

- [ ] **Step 1: Add RED SDK tests** for default automatic context, `context:false`, sidecar placement, bounded query/read deduplication, legacy `read_spilled` alias, manual `agent.compact()` using the engine, and resume/delete invalidation.
- [ ] **Step 2: Run the focused SDK tests and confirm missing API/sidecar behavior.
- [ ] **Step 3: Wire `context` through `createLiteAgent`/`query`; create one archive per session; register the stable context retrieval tool; keep `compactor`, `contextBudget`, and `spill` as deprecated adapters that do not compose with the new engine; route compact/restore/delete/cleanup through engine invalidation.
- [ ] **Step 4: Build core before SDK, then run the focused and full SDK test/typecheck suites.

### Task 5: Provider token counting and prompt-cache boundary

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/strategies.ts`
- Modify: `packages/provider/src/anthropic/anthropic.ts`
- Modify: `packages/provider/src/anthropic/mapping.ts`
- Modify: `packages/provider/src/anthropic/stream.ts`
- Modify: `packages/provider/src/openai/openai.ts`
- Create: `packages/provider/test/context-capabilities.test.ts`
- Modify: `packages/provider/test/anthropic-mapping.test.ts`
- Modify: `packages/provider/test/anthropic-stream.test.ts`

- [ ] **Step 1: Write RED tests** for optional count-token support, cache read/creation usage normalization, deterministic canonical tool/system ordering, and exact prefix snapshots across a tool loop.
- [ ] **Step 2: Run provider focused tests and verify the absent capability/usage fields fail.
- [ ] **Step 3: Implement the minimal optional capability object; map Anthropic cache breakpoints and `messages.countTokens` when the injected client supports them; preserve graceful fallback for OpenAI/local providers; retain unknown native blocks instead of converting them to summaries.
- [ ] **Step 4: Run provider build/test/typecheck and re-run core prefix integration tests.

### Task 6: Verification and cleanup

**Files:**
- Modify only files directly implicated by failing tests.
- Add or update focused docs under `docs/superpowers/specs/` only if public signatures changed.

- [ ] **Step 1: Run `pnpm -r build`.
- [ ] **Step 2: Run `pnpm -r test`.
- [ ] **Step 3: Run `pnpm -r typecheck`.
- [ ] **Step 4: Run `git diff --check`, inspect the diff for accidental changes to the six user-owned package/changelog files, and report any remaining compatibility adapter behavior explicitly.

## Self-review checklist

- [ ] Every spec section maps to a task above.
- [ ] No task exposes thresholds, archive paths, segment labels, or provider edit shapes in the public SDK config.
- [ ] No summary event is used as the durable conversation source.
- [ ] The static prefix is hashed/canonicalized once and is never part of compaction payloads.
- [ ] Planner failures are bounded and deterministic fallback remains available.
- [ ] Tests were observed failing before production code was added for each new behavior.
