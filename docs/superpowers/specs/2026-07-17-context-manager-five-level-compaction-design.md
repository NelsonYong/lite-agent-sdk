# Five-Level Context Manager and Session Archive

**Status:** Proposed design

**Date:** 2026-07-17

## Summary

The SDK should optimize for useful information retained in the model context,
not for the smallest possible message array. Context management therefore needs
to be pressure-aware, semantically selective, and reversible.

The design adds one orchestration concept, `ContextManager`, around the existing
deterministic compaction passes. It measures the dynamic transcript against the
available context budget, selects one of five pressure levels, optionally asks a
dedicated low-cost LLM for a structured retention plan, archives anything removed
before applying that plan, and leaves a short working-state anchor in context.

The static prompt prefix (system prompt, tools, and any codec-declared static
instructions) is never compacted. It is measured against the model window but
remains outside the mutable transcript. This preserves the SDK-side stability
precondition for prefix caching across normal agent loops and compaction
generations. The
first implementation treats provider prompt caching as an optional adapter
capability; a stable logical prefix must not be confused with a provider cache
hit.

## Goals

- Keep the highest-value facts in the active context for as long as possible.
- Preserve one logical static-prefix descriptor across a session; verify
  provider-payload byte stability only for codecs that expose a static protocol.
- Use progressively stronger actions as context pressure increases.
- Let a dedicated LLM decide which completed attempts and facts are worth keeping.
- Preserve failed-attempt lessons without retaining all failed-attempt transcripts.
- Archive removed material under the corresponding session so it can be retrieved.
- Make every lossy operation reversible through an archive reference.
- Keep existing `CompactPass`, `Compactor`, `Checkpointer`, and spill behavior useful.
- Keep the public API small and provide deterministic fallbacks when the planner
  or archive is unavailable.

## Non-goals

- A vector database, embedding index, or general-purpose RAG system.
- Replacing the model provider or introducing a second agent loop for planning.
- Automatically injecting the entire archive back into every request.
- Compressing or rewriting the system prompt or tool definitions.
- Treating the dedicated planner's output as trusted executable instructions.

## Current baseline

The existing SDK already has useful low-level pieces:

- `defaultCompactor()` runs `spill -> snip -> micro` before a model call.
- `tokenBudgetCompactor()` can enforce a message-token budget after structural
  passes.
- `reactiveCompaction()` catches context overflow and retries with a recent tail.
- `llmCompactor()` can summarize old turns, but it is not selective, is not
  session-archive aware, and is not the default.
- `LiteAgent.compact()` persists a `summary` session event while retaining the
  raw event log.

These pieces operate only on `messages`; `system` and `toolSpecs` are already
outside their input. The new design keeps that useful boundary and moves
selection/orchestration above the existing passes.

## Terminology

### Static prefix

The SDK-level logical prefix that must remain immutable:

```text
tools + system prompt + static codec protocol
```

The SDK assembles and freezes a `PrefixDescriptor` once per agent. Its
fingerprint is a hash of a canonical, ordered representation of the model,
system text, ordered tool definitions, codec identity/version, codec-declared
static protocol (if any), and other SDK-visible static request options. Provider
implementation-private options are out of scope for this first descriptor and
are covered only by the later provider cache seam. Messages,
sampling output limits, steer text, and other per-turn values are excluded.
The codec metadata is an optional additive seam (for example,
`describeStaticPrefix(): { id, version, protocol? }`). Built-in codecs provide
fixed values. A custom codec without the seam is tagged opaque for this agent
instance; its protocol is excluded from the provider-cache claim and the SDK
does not pretend that two processes have the same prefix. The descriptor is
measured but never passed to a compactor for rewriting.

### Dynamic transcript

The mutable portion after the static prefix:

```text
user prompts + assistant turns + tool results + steer + dynamic reminders
```

The transcript is segmented by completed turns. A segment has a deterministic
identity based on its session event range; no random ID is inserted into the
prompt.

### Context pressure

Let `windowTokens` be the provider model's context limit, `prefixTokens` the
estimated static-prefix size, and `outputReserveTokens` the space reserved for
the next response and tool calls:

```text
effectiveDynamicWindow = windowTokens - prefixTokens - outputReserveTokens
pressure = dynamicTranscriptTokens / effectiveDynamicWindow
```

The default estimator remains the existing character-based estimate when no
provider tokenizer is available. A provider-specific or user-supplied
estimator may replace it. The manager uses `context.estimator`, then the
legacy `contextBudget.estimator`, then the default estimator. Because the
current `TokenEstimator` accepts messages, the private prefix-estimation helper
serializes the canonical descriptor as deterministic pseudo-messages and calls
the same estimator; no new public estimator type is required. `windowTokens` is
optional: when it is omitted, proactive levels are disabled and the existing
overflow hook remains available as L5. A supplied non-finite or
non-positive `windowTokens`/`outputReserveTokens`, or a reserve that is greater
than or equal to the supplied window, is a configuration error at assembly
time. The default reserve is
`min(4_096, max(1, floor(windowTokens * 0.1)))`.

### Compression generation

Each successful compaction increments a per-session generation. A segment is not
replanned in the same generation, which prevents repeated summaries on every
turn. A later generation may reconsider it only if its state or references have
changed.

### Context snapshot

At each model boundary the kernel captures one immutable internal snapshot from
the same local event history/head used by its serialized append path:

```ts
type ContextSnapshot = {
  sessionId: string;
  head: number;
  messages: readonly Message[];
  segments: Array<{
    id: string;
    messageRange: readonly [start: number, end: number];
    eventRange: readonly [fromSeq: number, toSeq: number] | null;
  }>;
};
```

The kernel builds it with an internal provenance-aware fold; middleware-only
messages have `eventRange: null` and are archived as explicit snapshots. The
manager plans only against this snapshot, and `commitCompaction` compares
against this exact `head`. It never separately rereads the checkpointer to infer
ranges, so segment IDs, archive refs, and the summary share one CAS boundary.

## Five pressure levels

The thresholds are defaults, not five independent public classes. Higher levels
include the lower-level safety rules. Each level has an entry threshold and a
lower target watermark so the manager does not oscillate around one boundary.
The default hysteresis margin is five percentage points. After a level runs,
the manager records its generation and will not run that same level again until
pressure is below `entry - 5pp` or a higher level is required. A no-op level is
marked exhausted for that generation; it never retries the same planner
request in a loop. A provider-reported overflow is a hard external signal and
may force one additional emergency pass in an `overflowAttempt` subgeneration,
even if proactive L5 already ran; this exception is valid only when the pass
changes the dynamic transcript or creates new archive refs.

| Level | Enter at | Default target | Action |
| --- | ---: | ---: | --- |
| L1 reversible externalization | 50% | 45% | Move oversized/old tool-result bodies out of context; leave stable references. |
| L2 deterministic reduction | 65% | 55% | Apply existing micro/snipping passes to stale bodies and redundant middle turns, with an archive reference for anything removed. |
| L3 selective attempt compression | 75% | 60% | Planner classifies completed segments; superseded failures become lessons plus archive refs. |
| L4 semantic state compaction | 85% | 55% | Planner produces a canonical task state and summarizes older completed work. |
| L5 emergency recovery | 95% or provider overflow | 40% | Archive everything removable, retain the active turn, latest verified state, blockers, and recent tail, then retry once. |

The manager selects the highest threshold currently crossed; every selected
level includes the cheaper lower-level passes. A target watermark is
best-effort: one invocation performs at most one deterministic pipeline and
one planner request. If the target is not reached, the next model boundary
remeasures pressure and may select a higher level, but it does not loop inside
the same call. A failed L3/L4 planner call falls back to L2 once. L5 is the only
level allowed to trigger one provider retry.

## Information-retention policy

The planner and deterministic executor prioritize information in this order:

1. User goal, acceptance criteria, and explicit constraints.
2. Current task state and next action.
3. The latest verified successful result and its paths/artifacts.
4. Decisions, invariants, and unresolved blockers.
5. Lessons from failed or superseded attempts.
6. Raw logs, duplicated tool output, exploratory chatter, and regenerable data.

When the manager is enabled, no segment is silently discarded at L2 or above.
Before it leaves the active
transcript, its raw event range or body is archived and the retained marker or
summary contains a reference. L1 tool-result externalization uses the same
session archive and is reversible by its ref. A pure drop is allowed only for data classified as
regenerable and already represented by a deterministic marker.

## Architecture

### `ContextManager`

`ContextManager` is the only new orchestration concept. It owns:

- pressure measurement and level selection;
- generation and hysteresis state;
- invocation of deterministic passes;
- optional planner calls;
- archive-before-remove ordering;
- creation of the working-state anchor; and
- compaction metadata for events and observability.

Its proactive path is called from the existing `beforeModel` middleware path
with a `ContextSnapshot` and an apply callback. It also exposes one internal
`onOverflow` hook for the model-call wrapper. The hook owns the L5
pre-stream-overflow retry; when the manager is enabled, the standalone
`reactiveCompaction` middleware is not installed, so there is exactly one retry
owner. It never receives a mutable copy of the static prefix and cannot modify
`system` or `toolSpecs`.

Existing `CompactPass` implementations remain pure transforms. Existing custom
`Compactor` implementations remain valid as the deterministic base; the manager
wraps them instead of replacing the public contract immediately.

The manager is constructed by the SDK assembly layer, not discovered from
`AgentContext`. It receives the frozen `PrefixDescriptor`, the selected
`TokenEstimator`, an `archiveFor(sessionId)` factory, and a map of per-session
state/locks. It does not hold a `Checkpointer` directly. The kernel creates a
private per-run `commitCompaction(expectedHead, summary)` callback alongside
its serialized append closure; that callback updates the kernel's local head
and history before returning. The middleware passes that callback, the
immutable `ContextSnapshot`, turn, abort signal, and the existing
`recordSessionEvent` to the manager. `commitCompaction` is the sole path for a
summary; `recordSessionEvent` remains for ordinary side events and is never
called a second time for the same compaction. This prevents an assembly-level
write from leaving the kernel with a stale expected head and keeps the core
middleware contract small.

The state map is keyed by `sessionId`, so runs for different sessions never
share generation, hysteresis, or planner-failure counters. A session state is
created lazily from the latest committed summary/index generation, survives
multiple runs on the same agent instance, and is discarded by `deleteSession`
or archive GC. On process restart, generation and committed level are restored
from the summary/index; the in-memory planner circuit starts closed and can
open again after its configured failures.

The manager never mutates the snapshot in place. It returns a
`ContextDecision`:

```ts
type ContextDecision = {
  messages: Message[];
  level?: 1 | 2 | 3 | 4 | 5;
  generation: number;
  archiveRefs: string[];
  retry: boolean;
};
```

The decision contains the replacement `messages`, selected level, generation,
archive refs, and whether a provider retry is allowed. The
middleware calls `commitCompaction` first; only after that succeeds does it
assign `ctx.messages = decision.messages` and emit the compaction event. A
no-op decision returns the original message reference. The overflow hook uses
the same decision/apply path before its single retry, so proactive and reactive
flows cannot diverge.

Every lossy operation uses a two-phase commit. The manager snapshots the
candidate event ranges/bodies, writes an archive entry plus its index with a
temporary-file-and-rename protocol (and fsyncs where the backend supports it),
then applies the message replacement and appends a `summary`
event with the expected checkpointer head. Archive index entries begin as
`pending` and become `committed` only after that summary append succeeds;
on startup (and before a session is exposed) the archive reconciler scans the
latest committed summary events and promotes any pending refs they contain.
Only pending entries that are not referenced by any committed summary and are
past the GC grace period are removed. Thus a crash after summary append cannot
leave a live summary pointing at a ref that GC deleted. If either write fails,
the original messages remain in place. A custom `Compactor` is run against a
deep copy of the snapshot and the manager performs a structural diff, so an
in-place mutation cannot bypass the archive step; if its output differs, the
snapshot is archived before the output is committed.
This is the compatibility guarantee even when a custom pass has no archive
awareness.

### `ContextPlanner`

The planner is a provider/model seam used only at L3 and L4. It is not a child
agent and does not execute tools. It receives segment metadata, the current
working state, the desired target pressure, and explicit retention rules. It
returns a validated structured plan:

```ts
type CompressionPlan = {
  state: {
    goal: string;
    constraints: string[];
    decisions: string[];
    knownGoodState: string[];
    unresolvedIssues: string[];
    nextStep?: string;
  };
  segments: Array<{
    id: string;
    action: "keep" | "summarize" | "archive";
    classification: "active" | "failed" | "superseded" | "verified" | "unknown";
    confidence: "deterministic" | "high" | "low";
    group?: string;
    summary?: string;
    evidence?: string[];
    lesson?: string;
    reason: string;
  }>;
};
```

The plan is decoded through one internal Zod schema and the provider's existing
text stream (JSON extraction is limited to the planner response); it is not a
new public codec or an ad-hoc string parser. The executor treats omitted
segment IDs as `keep`, rejects unknown IDs, attempts to remove the active turn,
broken tool pairs, missing summaries/lessons for `summarize`/`archive`, or a
plan that omits the goal/current state. A `verified` classification is accepted
only when its `evidence` matches deterministic hints supplied in the snapshot;
the planner cannot promote an unsupported claim. Planner requests use the run abort signal,
`maxTokens` bounded to the planner schema, and the provider's normal default
temperature. The default timeout is 10 seconds and the default circuit opens
after two consecutive failures for the session; its open state is kept in the
manager state and is not persisted as conversation content. Timeout, malformed
output, or provider failure falls back to L2. The planner response is capped at
2,048 output tokens unless a future provider seam supplies a smaller bound.

One planner model is sufficient. It may be a smaller, cheaper model than the
main agent, and its call is bounded to one request per compression generation.
Its input contains segment metadata, deterministic evidence, bounded previews,
and archive refs; oversized raw tool bodies are never copied into the planner
prompt merely to decide that they should remain archived.

If no planner is configured, or its circuit is open, L3 and L4 execute L2 once
and emit a planner-unavailable diagnostic; they do not invent a semantic state
or working-state anchor. L5 remains deterministic: with an archive it retains
the active turn and recent paired tail, archives older completed turns, and
leaves only reference markers; without an archive it uses the explicitly
non-reversible emergency fallback described below.

### `ContextArchive`

The default archive reuses the existing event log as the raw source of truth;
it does not duplicate the entire transcript. `archiveDir`, when supplied, is a
base directory and the sidecar is always `<archiveDir>/<session-id>.context/`.
Without it, sessions-enabled agents use
`<paths.sessionsDir>/<session-id>.context/`; the manager creates that directory
lazily per session. When `sessions:false`, the default sidecar is disabled and
an explicit `archiveDir` is required to opt into message-snapshot archiving. A
sidecar directory stores a small index and planner-created notes next to the
session file:

```text
sessions/<session-id>.jsonl
sessions/<session-id>.context/
  index.jsonl
  notes/<ref>.md
```

An index entry records the reference, event sequence range, compression level,
generation, prefix fingerprint, labels, and retained summary. Index writes use a
temporary file plus rename; note files are bounded UTF-8 files. Raw event
ranges are read back through the configured `Checkpointer`. With a custom
legacy `Store`, or without a `Checkpointer`, an entry uses
`eventRange: null`, `source: "message-snapshot"`, and a content hash instead of
claiming an event sequence range. When the manager is enabled, L1 bodies are
also stored through `archiveFor(sessionId)` rather than the project-wide spill
directory. Without an archive directory, L1-L5 manager operations are disabled
and only the explicitly non-reversible reactive fallback is available. The
old project-wide spill store remains a compatibility path only when `context`
is absent.

The SDK registers one stable `read_context` tool at agent construction when
context archiving is enabled and the tool survives the normal
`allowedTools`/`disallowedTools` filtering. Its input is
`{ ref: string, includeRaw?: boolean, maxBytes?: number }`; the retained
summary is capped at 4 KiB, `maxBytes` defaults to 16 KiB, and raw output is
capped at 128 KiB. It validates an opaque ref against the sidecar index,
rejects path traversal, returns the bounded retained summary first, and returns
the raw event/body only when `includeRaw` is true. A missing or deleted ref is
a bounded tool error. If `allowedTools`/`disallowedTools` removes this tool,
the manager may retain a short summary but may not leave an archive ref as the
only representation of a fact; it falls back to keeping that segment. The
tool is not added lazily after compaction, because changing the tool list
mid-session would invalidate the prompt prefix. It is distinct from
`read_spilled`, which remains the legacy project-wide tool-result path when the
manager is disabled. The whole archive is never injected automatically.

`ContextArchive` exposes private `delete(sessionId)`, `truncate(sessionId,
head)`, and `sweep()` seams. `deleteSession`, restore/truncate, and stale-file
cleanup call those seams as well as operating on the `.jsonl` transcript.
The LiteAgent runtime also calls `ContextManager.invalidate(sessionId)` from
the same lifecycle hooks.
Deleting a session removes its `.context` directory; restoring to an earlier
sequence keeps the old notes but marks index entries beyond the new head stale,
so they cannot be read by default. Restore holds the per-session manager lock,
invalidates its generation/hysteresis/planner state, and rehydrates from the
latest committed summary at or below the restored head before the next run;
it never lets state from a truncated future influence a new plan.

### Working-state anchor

After L3, L4, or L5, the executor appends one compact dynamic user message with
the fixed marker `[context-state generation=<n>]` containing:

- goal and constraints;
- latest verified state;
- failed-attempt lessons;
- unresolved issues and next step; and
- archive references.

The anchor is part of the dynamic transcript, not the static system prompt. It
is replaced only when a new generation commits; ordinary turns never rewrite
an existing anchor. On resume, `foldEvents` takes the latest committed summary
as the base and the anchor in that summary is authoritative. An interrupted
L5 retry either commits one summary before retrying or leaves the original
active turn intact, so it cannot duplicate user/tool events.

## Attempt handling

The manager derives stable segments from the existing turn boundaries and event
sequence ranges; no public `Attempt` type is required initially. The only
deterministic failure hint currently guaranteed is `tool_result.isError`, plus
known text markers from configured tools (for example a test command's non-zero
result). There is no trusted `verified` flag in the current event model. A
result is therefore called "verified" only when a non-error tool result also
contains explicit success evidence (for example, a passing test summary);
otherwise the planner must retain it conservatively. The planner returns a
`classification`, optional `group`, confidence, and evidence for each segment;
the executor uses those fields only to choose among already-valid deterministic
hints and cannot invent a successful artifact path. The
`v1 -> v2 -> v3` example assumes such evidence for v3; without it, all three
attempts are kept or summarized conservatively.

For a `v1 -> v2 -> v3` task:

- v1 and v2 are archived as raw ranges;
- their failure causes are retained as short lessons;
- v3's verified result and active files remain in full context; and
- the working-state anchor explicitly says not to retry the v1/v2 approaches.

This retains the decision-making value of failed attempts without paying for
their complete logs on every subsequent turn.

## Persistence

The existing `summary` session event is extended additively with optional
`archiveRefs`, `generation`, `level`, and `prefixFingerprint` metadata. Its
`messages` field remains the active compacted view, while the original events
remain available for restore and archive reads. Automatic and manual
compaction both append this event through the checkpointer before swapping the
in-memory view; `throughSeq` is the checkpointer head captured in the same
compare-and-append operation. `foldEvents` continues to use the latest summary
as the model-facing base. If the append conflicts, the manager discards the
stale plan and aborts that run with `CheckpointConflictError`; it does not call
the provider with stale `ctx.messages` or attempt an in-place merge. The
caller's next run reloads and folds the committed head before measuring again.
A backend must expose the full `appendSummary` semantic and
preserve the additive metadata to enable automatic lossy levels. A legacy
adapter that can only fold message summaries stays on the old compactor path
and does not advertise durable resume semantics for the new levels.

Manual `agent.compact(instructions)` invokes the same manager and planner as
automatic compaction. Instructions steer what the planner preserves; they do
not alter the static prefix and the action still produces no model answer.

## Prefix and provider behavior

- `system`, tools, and codec-declared static instructions are assembled once
  and hashed into the logical prefix descriptor.
- The manager measures that prefix but never compacts it.
- Dynamic reminders and archive reads are appended after the existing transcript.
- Provider cache breakpoints and cache-token usage are a later additive provider
  seam. An adapter may expose them, but Anthropic/OpenAI adapters that do not
  support the fields simply send the ordinary request and report no cache
  metrics; five-level compaction does not depend on them.
- After compaction, the static-prefix generation remains valid; only the rolling
  transcript generation changes.
- If tools, model, or static protocol changes, the fingerprint changes and the
  manager records a new prefix generation rather than pretending cache continuity.

## Public configuration

The public surface should add one grouped option rather than five level-specific
options:

```ts
context?: {
  windowTokens?: number;
  outputReserveTokens?: number;
  estimator?: TokenEstimator;
  planner?: {
    provider: ModelProvider;
    model: string;
    timeoutMs?: number;
    maxFailures?: number;
  };
  archiveDir?: string;
}
```

The existing `compactor`, `contextBudget`, and `spill` options remain accepted:

- an existing `Compactor` supplies or replaces the deterministic base;
- `contextBudget` remains a compatibility shortcut for a hard dynamic budget;
  when both are present, the manager's target is additionally capped by that
  hard budget, and `context.estimator` wins over its legacy estimator;
- `spill` continues to control the L1 byte threshold; with `context` enabled it
  stores through the session archive, otherwise it keeps the legacy spill
  store behavior; and
- `planner` is optional, so deterministic five-level fallback remains usable.

When `context` is absent, existing compaction behavior is unchanged. When
`compactor: false` is explicit, proactive levels are disabled (including the
planner); an explicitly configured reactive overflow middleware may still be
used. A planner without an available archive is disabled for L3-L5 because a
lossy plan must be reversible. `windowTokens` is normally supplied by the
caller/model registry; the SDK does not guess a provider limit.

No public option exposes individual segment classifications or permits callers
to mutate the static prefix during a run.

## Failure and safety behavior

- Archive write happens before any message is removed. On write failure, the
  active transcript is left unchanged and a non-fatal diagnostic is emitted.
- Planner failure falls back to deterministic L2; repeated failures disable the
  planner for the session.
- The manager's overflow hook replaces standalone `reactiveCompaction` and
  retries only once, only when the provider failed before streaming output.
- If proactive L5 already ran, the overflow hook may run the one forced
  `overflowAttempt` pass above, but it must produce a strictly smaller or newly
  externalized dynamic transcript before retrying. An unchanged request is
  never retried.
- The active turn is the newest user prompt plus any assistant/tool messages
  produced from it; L3-L5 never remove it. On pre-stream overflow L5 may compact
  only completed earlier turns, commit one summary, and re-encode the same
  active turn for the retry.
- An oversized tool result inside the active turn may be reversibly spilled
  while preserving its tool-result block and ref. If the user prompt or other
  non-spillable active content alone exceeds the effective window, the manager
  raises a typed `ContextOverflowUncompressible` error and does not retry; it never
  silently truncates the current user request.
- The checkpointer's expected-head compare-and-append is the session generation
  check. A conflict aborts the whole run before the provider call instead of
  applying or continuing with stale messages.
- If no durable archive exists during a real provider overflow, the manager may
  invoke the existing `reactiveTrim` as a last-resort, explicitly
  non-reversible compatibility fallback and emits that fact in the compaction
  diagnostic. It still owns the single retry.
- A missing archive reference returns a bounded error; it never blocks the main
  loop indefinitely.
- Tool-call/tool-result pairing is validated after every plan and fallback.

## Verification plan

Tests must cover:

- pressure calculation including static prefix and output reserve;
- all five thresholds, target watermarks, and hysteresis;
- unchanged system/tools/prefix fingerprint across every level;
- L1/L2 idempotence and tool-pair preservation;
- the v1/v2 failed, v3 successful selection fixture;
- invalid planner output and planner timeout fallback;
- archive-before-remove ordering and `read_context` round trips;
- summary persistence, resume, restore, and generation metadata;
- manual compaction using the same planner path;
- provider request snapshots proving only the dynamic suffix changes in a normal
  loop for codecs that expose a static prefix (and a provider-specific
  degradation assertion for codecs that do not);
- estimator precedence and invalid reserve/window validation;
- archive-base layout, `sessions:false`, custom/legacy stores, sidecar
  delete/GC/restore state rehydration, provenance/range mapping, and pending-ref
  reconciliation both before and after a committed summary;
- no-planner/no-archive fallback, filtered `read_context`, archive-write
  failure, and omitted/unknown/unsupported planner classifications;
- concurrent compaction conflicts (one commit, one aborted stale run, no stale
  provider call) plus manager-vs-reactive L5 retry ownership, forced-overflow
  subgeneration, and no retry for an unchanged request.

## Rollout order

1. Add the frozen prefix descriptor, provenance-aware context snapshot,
   expected-head kernel commit seam, pressure measurement, and five-level
   deterministic manager around the existing passes.
2. Add session sidecar lifecycle, archive-before-commit, and stable
   `read_context` registration.
3. Add the internal Zod planner schema and v1/v2/v3 selection behavior.
4. Route automatic and manual compaction through the same manager and summary
   metadata.
5. Add optional provider-specific cache breakpoints and cache usage reporting.

The first four steps can ship without changing `ModelProvider`/`ModelRequest`;
the prefix descriptor is built by the SDK assembly and degrades to logical-only
accounting. The last step is an additive provider capability and can be
implemented independently.
