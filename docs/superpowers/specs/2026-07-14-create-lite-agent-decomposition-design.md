# `createLiteAgent` Decomposition Design

## Status

Approved for implementation planning on 2026-07-14.

## Context

`packages/sdk/src/createLiteAgent.ts` is 485 lines and currently combines two
major responsibilities:

1. assembling the SDK batteries and the primitive core agent; and
2. implementing the stateful `LiteAgent` session facade.

The feature implementations themselves already live in focused modules. The
problem is orchestration density, not a missing extension framework. This
refactor must therefore separate the existing responsibilities without adding
new runtime behavior or converting the SDK into a plugin container.

## Goals

- Preserve all public APIs and observable behavior.
- Make `createLiteAgent()` a short, sequential composition root.
- Isolate the stateful session facade from construction-time assembly.
- Keep tool, middleware, persistence, and compaction ordering explicit.
- Leave a clear internal location for future SDK batteries.
- Improve test coverage around assembly rules before moving code.

## Non-goals

- No new SDK capability, configuration option, or public export.
- No Battery interface, contribution protocol, registry, builder, base class,
  dependency-injection container, or service locator.
- No changes to tools, tasks, skills, subagent behavior, persistence formats,
  compaction behavior, event streams, or error types.
- No cleanup of unrelated code and no version or changelog update.
- No attempt to redefine structured-output behavior for aborted, failed, or
  concurrent runs on the same session.

## Chosen architecture

Use a thin composition root, one assembly module, and one stateful facade
module. All dependencies remain explicit plain values and functions.

```text
query/index
    |
    v
createLiteAgent.ts
    |-- liteAgentAssembly.ts
    |       |-- core createAgent
    |       `-- existing SDK capability modules
    `-- liteAgent.ts
            |-- core Agent/Checkpointer/Compactor contracts
            `-- existing safe file primitives
```

### `createLiteAgent.ts`

This remains the stable public factory module and composition root. It owns:

- public type re-exports for direct-import compatibility;
- project-path resolution;
- the existing once-at-construction cleanup call;
- the recursive child-agent `Spawn` policy;
- the call to `assembleLiteAgent()`; and
- the call to `createLiteAgentFacade()`.

The child-agent spawn closure stays here because it recursively calls
`createLiteAgent()`. The assembly module receives the closure as a dependency
and never imports the public factory, preventing an ESM cycle.

The factory keeps path resolution and cleanup explicit, defines the existing
`Spawn` closure inline, calls `assembleLiteAgent({ cfg, paths, spawn })`, and
passes the resulting runtime plus `cfg.workdir` to `createLiteAgentFacade()`.

### `liteAgentAssembly.ts`

This internal-only module converts `CreateLiteAgentConfig` into the runtime
dependencies needed by the facade. It owns:

- ordered default and optional tool assembly;
- skill and subagent descriptions used by the system prompt;
- spill and task stores;
- structured-output tool, prompt suffix, and capture state;
- compactor selection and structural/budget composition;
- checkpointer selection;
- middleware construction and ordering; and
- creation of the primitive core `Agent`.

It returns a small, explicit record rather than a mutable container:

```ts
interface LiteAgentRuntime {
  core: Agent;
  checkpointer?: Checkpointer;
  compactor?: Compactor;
  takeOutput?: (sessionId: string) => unknown;
}
```

The record is construction output only. Consumers must not mutate it or use it
as a service locator.

### `liteAgent.ts`

This module owns the public `CreateLiteAgentConfig`, `LiteAgentResult`, and
`LiteAgent` types plus the internal `createLiteAgentFacade()` factory. Moving
the types avoids a type dependency from the facade back to the composition
root. `createLiteAgent.ts` re-exports the types so existing direct imports and
the package-root exports remain unchanged.

The facade owns:

- `currentSessionId`;
- `run()` and `send()`;
- attaching a captured structured result after a normal core run;
- `resume()` and `clear()`;
- session list/delete operations;
- checkpoint listing;
- file and conversation restore; and
- manual compaction.

## Assembly invariants

### Tool order

The following order is observable and must remain unchanged:

```text
default tools
-> skills
-> spill
-> tasks
-> Agent
-> background tools
-> user tools
-> ask_user
-> allowedTools filtering
-> disallowedTools filtering
-> final_answer
```

`final_answer` remains registered after filtering so allow/deny lists cannot
remove it. Existing duplicate-name behavior is also preserved.

### Checkpointer precedence

The selection order remains:

```text
explicit checkpointer
-> adapted legacy store
-> disabled by sessions:false
-> default file checkpointer
```

The selected checkpointer is instantiated once and shared by the core agent and
the stateful facade.

### Compactor composition

- `compactor: false` disables compaction.
- An explicit compactor wins over the deterministic default.
- When configured, token-budget compaction runs after structural compaction.
- The default structural compactor continues to receive the spill store and
  spill budget.

### Middleware order

The order remains:

```text
compaction
-> permission
-> user middleware
-> task reminder
```

The task reminder remains innermost. The order stays visible in the assembly
module rather than being hidden in a generic pipeline abstraction.

### Subagent inheritance

Each dispatch creates a fresh child `LiteAgent`. The child continues to inherit
the parent configuration and then apply the current overrides:

- use the agent definition's system prompt, model, and optional tool allowlist;
- disable nested agents and startup cleanup;
- apply `subagentPermission`;
- remove approval and input handlers;
- remove structured output; and
- preserve persistence inheritance exactly: pass through an explicit
  checkpointer, continue inheriting a legacy `store` through the parent config,
  and otherwise let the child create its default file checkpointer.

No child-agent cache or module-level state is introduced.

## State and lifecycle semantics

- `createLiteAgent()` remains synchronous.
- `run()` captures its session ID when called. `opts.sessionId` wins over the
  facade's current session, and later `resume()` calls do not redirect that run.
- `resume()` remains lenient for unknown IDs.
- `clear()` creates a new ID without deleting the previous session.
- Structured output remains keyed by session and is consumed only after normal
  generator completion.
- Restore continues to select the earliest post-checkpoint snapshot per file,
  skip truncated snapshots, resolve paths safely, and use atomic writes.
- Restore changes `currentSessionId` only after all requested file and
  conversation operations succeed.
- Manual compaction continues to operate on the current session and emits the
  same start/done events.

## Error handling

The refactor introduces no error translation layer:

- session operations without a checkpointer continue to reject with the current
  `AgentError`;
- conversation restore without `truncate` support continues to fail;
- manual compaction without a compactor continues to fail;
- core, subagent, checkpointer, and filesystem errors continue to propagate;
- no new error class, result wrapper, catch-all, or fallback is added.

## Future battery boundary

New batteries are added as explicit sections in `liteAgentAssembly.ts`. If a
single battery genuinely contributes multiple surfaces, such as tools plus a
middleware and prompt description, it may receive a battery-specific plain
factory returning concrete fields.

There is intentionally no generic contribution interface. A shared protocol is
considered only after multiple future batteries demonstrate the same stable
shape and ordering rules.

## Characterization tests

Before extraction, add tests that pass against the current implementation and
pin the assembly behavior not covered today:

- custom/default duplicate tool-name behavior;
- `disallowedTools` filtering;
- `final_answer` surviving allow/deny filtering;
- explicit checkpointer, legacy store, and `sessions:false` precedence;
- structural then token-budget compactor composition;
- compaction, permission, user middleware, and task-reminder ordering;
- child-agent inheritance and removal of recursion, interactivity, and
  structured output; and
- custom system prompt plus structured-output suffix behavior.

Existing session, restore, manual compaction, output-schema, task, skill,
cleanup, and subagent tests remain the primary coverage for those features.
Tests must exercise the public `createLiteAgent()` behavior rather than expose
or couple to the new internal modules.

## Implementation sequence

1. Add the missing characterization tests and establish a green baseline.
2. Move public contracts and extract the stateful facade.
3. Extract compactor, checkpointer, middleware, and core-agent assembly.
4. Extract tool, prompt, structured-output, and subagent assembly last.
5. Run focused SDK tests after each extraction.
6. Build `@lite-agent/sdk` before validating `@lite-agent/local`, because
   workspace dependents consume built `dist` artifacts.
7. Finish with topological workspace build, tests, and typecheck.

## Verification and acceptance criteria

- `createLiteAgent()` has the same signature and synchronous behavior.
- Package-root and direct-module type imports continue to compile.
- `@lite-agent/local` continues to extend and consume the SDK contracts without
  source changes.
- Tool order, middleware order, defaults, session behavior, event streams,
  structured output, restore, compaction, and error propagation are unchanged.
- No new production capability, public export, dependency, version, or
  changelog change is present.
- `createLiteAgent.ts` reads as a composition root; no numeric line-count target
  is used as a substitute for cohesive boundaries.
- Full workspace build, offline tests, and typecheck pass.

## Risks and mitigations

- **Hidden ordering change:** characterize tool and middleware order before
  extraction and keep the arrays visibly ordered.
- **Circular dependency:** inject `Spawn`; the assembly module must not import
  `createLiteAgent()`.
- **Structured-output drift:** move its tool, prompt suffix, capture state, and
  result consumer as one bridge.
- **Session-state drift:** keep all mutable session ownership in one facade.
- **Persistence split-brain:** create one checkpointer and pass the same instance
  to core and facade.
- **Downstream type breakage:** retain compatibility re-exports and build SDK
  before checking the local package.
