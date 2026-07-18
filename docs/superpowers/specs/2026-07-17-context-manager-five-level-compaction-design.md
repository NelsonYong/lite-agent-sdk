# ContextEngine and Immutable ContextView

**Status:** Approved direction

**Date:** 2026-07-17

## Decision

The SDK will treat context as a runtime projection, not as a pile of
independent compactor APIs. The session event log remains the source of truth;
the model receives a `ContextView` rendered from that log, a small fact ledger,
the current working state, and a recent tail.

There is one internal owner, `ContextEngine`. It owns pressure measurement,
the five internal policies, archive selection, planner calls, provider context
capabilities, overflow recovery, and the rendered view. The five levels are
policy data, not public classes or configuration knobs.

The public API exposes one concept:

```ts
context?: false | {
  /** Optional model used only for selective retention proposals. */
  planner?: { provider: ModelProvider; model: string };
  /** Required only when the provider cannot describe its context window. */
  windowTokens?: number;
}
```

`context: undefined` means automatic context management. `context: false`
disables it. `archiveDir`, thresholds, generation IDs, segment classifications,
token estimators, spill budgets, and provider-specific edit shapes are not
public context options. The SDK derives the archive directory from the session
directory and obtains token counting/cache capabilities from the provider.

The existing `compactor`, `contextBudget`, `spill`, `llmCompactor`, and
`reactiveCompaction` APIs become deprecated compatibility adapters. They are
not composed with the new engine. A legacy option explicitly supplied by a
caller selects the adapter path and emits one migration diagnostic; new code
uses `context` only.

## Why this shape

The current runtime has several independent owners of `ctx.messages`: structural
compaction, token budgeting, reactive retry, manual compaction, and task
reminders. That makes prefix stability, persistence, and concurrency difficult
to reason about. A single engine gives the kernel one render/apply path and
keeps the public mental model to “the agent manages its context.”

Compression is not the source of truth. A summary is a derived view and can be
discarded and rebuilt; it can never silently replace a user fact or a raw event.

## Architecture

```text
immutable SessionLog
        |
        +--> FactLedger (verbatim pins + evidence refs)
        +--> SegmentIndex (turns, tool results, artifacts, consumed state)
        +--> ContextEngine (policy, planner, archive, provider capabilities)
                         |
                         +--> ContextView renderer
                                      |
                         static prefix + dynamic context suffix
```

### SessionLog

`Checkpointer` remains the durable append/read/CAS boundary. Conversation,
tool, file-snapshot, permission, and context-view metadata are append-only
events. Compaction never deletes raw conversation events. `summary` events are
read-only compatibility input; new code writes a `context_view` event containing
derived state and archive references, not a replacement conversation transcript.

The kernel owns one serialized append closure and one local head. ContextEngine
receives a kernel-bound snapshot and `commitView(expectedHead, view)` callback;
it never writes a checkpointer directly. A CAS conflict aborts the current run
before the provider call. The next run reloads the log and rebuilds the view.

### FactLedger

The ledger is deterministic and provenance-bearing. It contains:

- verbatim user goal, hard constraints, and acceptance criteria;
- verified artifact pointers (`path`, revision/content hash, verification command,
  and result);
- explicit user supersessions; and
- evidence refs to the originating event sequence/body.

Facts are append-only in normal operation. A planner cannot delete, paraphrase,
or overwrite a fact. Removing a constraint requires a later explicit user
supersession or deterministic evidence. The executor renders pins from the
ledger on every generation, so there is no summary-of-summary drift.

### ContextView

`ContextView` is an internal immutable value:

```ts
type ContextView = {
  generation: number;
  facts: readonly Fact[];
  workingState: readonly StateEntry[];
  segments: readonly ContextSegment[];
  archiveRefs: readonly string[];
  messages: readonly Message[];
  prefixFingerprint: string;
};
```

`messages` is a rendered model view. Middleware cannot mutate the durable view
in place. A turn reminder or retry repair is a request-local suffix overlay and
is never persisted as a fact or inserted into the static prefix.

The renderer keeps the static prefix byte-stable and changes only the dynamic
suffix after the current cache boundary. If a provider cannot preserve a
middle-prefix cache after a semantic rewrite, the engine records a new cache
generation instead of claiming a hit.

### SegmentIndex and archive

The index is session-scoped and derived from `StoredEvent` provenance. It tracks
event ranges, labels, tool names, artifact pointers, whether a result has been
presented to the model, and archive refs. New tool results are protected until
at least one successful model request sees them, unless the provider overflows.
Oversized active results retain a deterministic preview (head/tail/error lines,
byte count, and content hash).

The default sidecar is:

```text
sessions/<session-id>.jsonl
sessions/<session-id>.context/
  index.jsonl
  notes/<ref>.md
```

Archive reads are discoverable, not ref-only. The stable context tool accepts a
bounded `query` or `ref`, returns a short data-wrapped summary first, and enforces
a per-turn read budget tied to remaining dynamic context. Repeated reads of the
same ref in one generation return the short summary. Archived content is marked
as historical data and never treated as executable instructions.

The event log is the raw source; sidecar notes and indexes are rebuildable.
Delete, restore, and cleanup invalidate the per-session engine state and update
the sidecar under the same session lock.

### Planner

The planner is optional and is called only when deterministic/native edits cannot
reach the target. It returns a proposal delta, never a replacement state:

```ts
type ContextProposal = {
  segments: Array<{
    id: string;
    action: "keep" | "summarize" | "archive";
    classification: "failed" | "superseded" | "verified" | "unknown";
    evidenceRefs: string[];
    summary?: string;
    lesson?: string;
  }>;
  stateDelta: {
    decisions?: string[];
    unresolved?: string[];
    nextStep?: string;
  };
};
```

The executor validates IDs, tool pairing, active-turn protection, evidence
refs, and archive-before-view-commit. It merges only additive state deltas;
unsupported verified claims and deletions are ignored. Planner input uses the
existing redactor, the same data-residency/provider policy as the main model by
default, and a short soft latency budget. Timeout or failure immediately falls
back to deterministic policy without blocking the user-facing run.

### Five internal policies

The levels are selected by measured pressure, but are not exposed publicly:

1. **Externalize:** move old/large, already-consumed tool bodies to the
   session archive or provider-native clear-tool/thinking edits.
2. **Normalize:** deduplicate repeated reminders, collapse regenerable logs, and
   clear stale tool/thinking blocks. It does not delete semantic user/assistant
   turns solely because they are old.
3. **Select:** use the planner to archive/summarize completed failed or
   superseded segments with evidence refs.
4. **Project:** rebuild a compact working state from the fact ledger and
   verified artifacts; use provider-native compaction when available.
5. **Recover:** on pre-stream overflow, run one strictly reducing emergency
   pass and retry once. If the active non-spillable request alone is too large,
   raise a typed overflow error rather than truncating user input.

Provider-native context editing is preferred in levels 1/2/4. Native clear
edits and native compaction are separate capabilities. A native compaction
block must round-trip through the provider adapter and checkpoint unchanged; it
must never be converted into ordinary summary text.

### Provider capabilities

`ModelProvider` gains one optional capability object; ordinary providers remain
valid without it:

```ts
type ProviderContextCapabilities = {
  contextWindow?: number;
  countTokens?(req: ModelRequest, signal?: AbortSignal): Promise<number>;
  clearToolUses?: ProviderContextEdit;
  clearThinking?: ProviderContextEdit;
  compact?: ProviderContextEdit;
  promptCache?: ProviderPromptCache;
};
```

The generic core does not contain Anthropic beta request shapes. Anthropic
adapters may implement token counting, clear edits, compaction blocks, exact
rendered-prefix fingerprints, cache breakpoints, and cache usage. OpenAI/local
adapters may expose only what they support and fall back to the local estimator.
Normalized usage adds optional cache-read/cache-creation fields.

Tool names, skill descriptions, JSON keys, workdir paths, and codec protocol
blocks are canonicalized once before the prefix is frozen. Dynamic reminders
use a provider-aware dynamic channel or an explicitly data-wrapped suffix; they
are never disguised as executable user instructions.

### Concurrency and observability

The engine serializes writes per session. A normal concurrent run is queued or
rebased by the runtime; users do not see routine CAS errors. A single
`context_status` event reports trigger, level, pressure, before/after tokens,
planner latency/fallback, archive refs, retry reason, prefix generation, and
provider cache usage.

## Public migration

New code should only need `context?: false | ContextOptions`. `agent.compact()`
remains the one manual action and uses the same engine path. Legacy compactor
and spill exports remain one release as adapters for existing callers, but are
not part of the new documentation or assembly path. The new context archive
uses one stable retrieval tool; `read_spilled` is an alias only during
migration.

## Verification requirements

Tests must prove:

- fact pins survive arbitrary planner output and repeated generations;
- ContextView projection preserves event provenance and tool pairing;
- semantic turns are not removed at deterministic level 2;
- new tool results are presented before externalization;
- archive query/read budgets prevent read-compress-read loops;
- provider countTokens/cache usage and exact prefix snapshots work when
  capabilities are available and degrade cleanly when absent;
- native compaction blocks round-trip across stream, checkpoint, and resume;
- planner timeout does not add a long synchronous stall;
- one session writer owns append/view commit and restores rehydrate state; and
- prefix/system/tools remain stable across normal loops and compaction views.

## Rollout

1. Add the immutable ContextView projector and engine-owned append/view commit
   seam in core.
2. Move kernel model rendering, overflow retry, manual compact, and task/reminder
   overlays to the engine; keep old compaction passes as private adapters.
3. Add SDK session sidecar/index/search tool and the minimal `context` option;
   deprecate old context-specific options.
4. Add provider token counting, exact cache usage/breakpoints, and deterministic
   prefix canonicalization.
5. Add native clear/compact blocks as an independent provider vertical slice.
