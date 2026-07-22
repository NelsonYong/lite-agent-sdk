# Model tier routing design

## Status

Proposed design for review. This document covers the first explicit model-tier
configuration and dispatch slice. Automatic task classification and escalation
are intentionally future extensions.

## Problem

The SDK currently accepts one `ModelProvider` plus one optional `modelName`.
That is enough for a single model, but it cannot express a cheap model for
small tasks and a stronger model for ambiguous or cross-package work. The
existing subagent frontmatter has a `model` string, but that string is treated
only as a raw request-time model id; there is no shared catalog, display
metadata, default tier, or per-task tier override.

The target is an explicit, provider-aware model catalog with three capability
tiers:

- `simple`: fast/low-cost work with low ambiguity;
- `medium`: the balanced default for ordinary implementation and debugging;
- `complex`: architecture, cross-package, high-uncertainty, or high-iteration work.

`defaultModel` selects the tier used when no more specific selection exists. It
is a tier key, not a provider model id.

## Design principles

Claude Code and Codex separate model family, reasoning effort, fallback, and
agent role instead of collapsing them into one difficulty enum. This SDK should
follow the same boundary:

1. A model profile selects a provider and a concrete model id.
2. A tier is a stable application-level alias for that profile.
3. A subagent role supplies a default tier; a task may override it explicitly.
4. Reasoning effort, budgets, permissions, and concurrency remain separate
   controls. They are not inferred from the tier in this change.
5. The kernel continues to execute one resolved provider/model pair. Routing is
   an SDK assembly concern, not a new kernel loop.

Task difficulty is not the same as operational risk. A short destructive
command can be cognitively simple but still needs strict permissions and
approval. Model tier and security policy must remain independent.

## Public configuration

The new tiered form is conceptually:

```ts
export type ModelTier = "simple" | "medium" | "complex";

export type ModelProfile = {
  provider: ModelProvider;
  /** Provider-facing model id; this is sent as ModelRequest.model. */
  modelName: string;
  /** Human-facing label for UI, logs, and diagnostics. */
  displayName?: string;
};

export type ModelCatalog = {
  models: Record<ModelTier, ModelProfile>;
  defaultModel: ModelTier;
};
```

Example:

```ts
const claude = anthropic({ apiKey });

const agent = createLiteAgent({
  models: {
    simple: {
      provider: claude,
      modelName: "claude-haiku-4-5",
      displayName: "Claude Haiku",
    },
    medium: {
      provider: claude,
      modelName: "claude-sonnet-4-6",
      displayName: "Claude Sonnet",
    },
    complex: {
      provider: claude,
      modelName: "claude-opus-4-6",
      displayName: "Claude Opus",
    },
  },
  defaultModel: "medium",
  workdir,
});
```

`displayName` is metadata only. It is never sent to the provider and must not
replace `modelName` in a `ModelRequest`. The resolver normalizes an omitted
display name to the model id for diagnostics, so the initial configuration can
remain compact while every resolved profile has a usable label.

The legacy form remains supported:

```ts
createLiteAgent({
  model: provider,
  modelName: "claude-sonnet-4-6",
  workdir,
});
```

Legacy configuration resolves to a single effective profile. It does not gain
three synthetic capabilities; it simply preserves the existing behavior.
Tiered configuration may use different providers per tier. A provider is
therefore part of each profile rather than a single top-level field.

## Selection and inheritance

The effective selection for a child task follows one deterministic chain:

```text
task.model override
  -> subagent definition model
  -> current agent defaultModel
  -> catalog defaultModel (root)
```

The selection value is a tier key (`simple`, `medium`, or `complex`). The
existing subagent `model` string remains accepted as a raw provider model id for
backward compatibility. When a string matches a configured tier, it is treated
as the tier alias; otherwise it is passed through as the legacy model id on the
inherited provider.

The root agent resolves `defaultModel` once at assembly. A child agent receives
the same catalog and a resolved default tier, so grandchildren inherit the
selected role tier without mutating the parent session. Each child still gets
its own provider/model pair and session lifecycle.

The `Agent` task input gains an optional `model` string. The schema remains
string-compatible so existing raw model ids continue to parse; the runtime
resolver gives the exact configured tier names their alias meaning. Because an
existing definition may use any raw model id, every other string is retained as
a legacy raw model id; the first release does not reserve arbitrary strings for
future custom tier names.

## Resolution boundary

Add one SDK-local `resolveModelSelection` normalization seam that returns a
resolved model:

```ts
type ResolvedModel = {
  provider: ModelProvider;
  modelName: string;
  displayName: string;
  tier?: ModelTier;
};
```

The seam is used by:

- `createLiteAgent` before SDK assembly;
- the child `spawn` closure before constructing an isolated child;
- context-engine and compaction setup, so they use the selected child
  provider/model pair;
- model-call diagnostics, where the existing model id remains stable and tier
  plus display name can be added as optional metadata.

The core `ModelProvider`, `ModelRequest`, kernel loop, and provider mapping
contracts do not change. A single kernel run always sees one resolved provider
and one concrete model id.

## Task grading guidance

The first release documents a rubric for the parent agent and application
authors; it does not run a separate classifier model.

| Tier | Signals | Typical execution |
| --- | --- | --- |
| `simple` | Known procedure, one small file, read-only lookup, low ambiguity | One worker, low iteration budget |
| `medium` | Multiple files in one package, ordinary bug fix, tests, moderate ambiguity | One worker plus optional review |
| `complex` | Cross-package architecture, concurrency/persistence, external research, repeated failure, or high uncertainty | Strong worker/planner, larger context and verification budget |

The parent model chooses a tier when it has the task context and passes that
choice in the `Agent` call. This is cheaper and more explainable than a second
classifier call. Future routing may be added as an optional `ModelRouter` hook,
but it must remain outside the kernel and must be able to report why it chose a
tier.

Future escalation can be evidence-based rather than prediction-based:

```text
simple -> medium  after tool/test failure or no-progress evidence
medium -> complex  after cross-package impact, architectural uncertainty, or
                   repeated repair failure
```

Escalation is not part of the first implementation. It will need explicit
cost/turn limits and a clear child-session handoff contract before being
enabled.

## Error handling

- A tiered catalog must contain `simple`, `medium`, and `complex` profiles.
- `defaultModel` must name one of those profiles.
- A profile must have a provider and non-empty model id.
- Missing or invalid tier configuration fails during `createLiteAgent`
  normalization, before a model request starts.
- A provider failure remains a provider failure; the SDK does not silently jump
  to another tier. A future fallback list is a separate availability policy.
- A legacy raw model id continues to use the inherited provider, preserving the
  current subagent behavior.

## Observability

The existing model id in `model_call_start`/`model_call_end` remains the
provider-facing value for compatibility. Optional fields may expose `tier` and
`displayName` so applications can compare quality, latency, retry count, and
token cost by tier without parsing model ids.

The first implementation should test that display names never enter provider
request mapping and that a child task reports the actual selected model id.

## Testing strategy

Focused tests should cover:

1. Legacy single-model configuration still makes the same request.
2. Tiered configuration resolves each tier to its own provider and model id.
3. `defaultModel` is used when no child/task override exists.
4. Task override wins over subagent definition, which wins over the parent
   default.
5. A definition using a raw model id remains compatible.
6. Invalid catalog keys, missing tiers, empty ids, and invalid defaults fail at
   construction time.
7. Child context/compaction uses the selected child provider/model pair.
8. Display names are preserved in diagnostics but never sent in requests.
9. Distinct fake providers prove that per-tier provider selection is honored.

Existing tests that construct `createLiteAgent({ model, modelName })` must remain
unchanged. New tests should use deterministic fake providers and inspect the
captured `ModelRequest.model` rather than relying on provider network calls.

## Scope and non-goals

Included:

- tier/profile types and SDK configuration;
- catalog normalization and validation;
- root default selection;
- subagent inheritance and per-task explicit override;
- display metadata and focused diagnostics;
- documentation and regression tests.

Not included:

- an automatic difficulty classifier;
- automatic escalation or retry across tiers;
- coupling tiers to Anthropic/OpenAI-specific reasoning parameters;
- changing the core kernel or provider strategy interfaces;
- a global model registry, pricing database, or capability discovery service;
- changing permissions, sandboxing, concurrency, or context policy based on tier.
