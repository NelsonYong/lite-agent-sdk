# Design: file-defined subagents with parallel dispatch + persistence

Date: 2026-06-25
Status: approved

## Goal

Add **subagents** to the sdk: agent definitions loaded from `agents/*.md` files in
the project and user directories (mirroring Claude Code), dispatched by the main
agent through a single `Agent` tool that supports **parallel fan-out**, with each
subagent run **persisted** to disk and **resumable** — the model Claude Code uses.

All new code lives in the **sdk** package (orchestration = batteries; see the
`multi-agent-goes-in-sdk` memory). **core is unchanged** — `createLiteAgent`,
`runKernel` (which already loads-and-prepends a session by id), `jsonlStore`,
`sweepStale`, and the existing `SkillLoader`/path helpers are sufficient. The
subagent tool closes over the model provider + agent registry (because
`ToolContext` carries none of that), exactly as `taskTools(store)` closes over its
store.

## Background: how Claude Code / the Agent SDK do it

- Subagents are `.md` files with YAML frontmatter; the **body is the system
  prompt**. Frontmatter: `description` (when to use), `tools`/`disallowedTools`,
  `model`, plus extras we omit for the MVP.
- Two locations with precedence: **project** `.claude/agents/` wins over **user**
  `~/.claude/agents/`; identity is the `name` field, subfolders are cosmetic.
- The main agent spawns one via a single tool (renamed `Task` → **`Agent`**) with a
  `subagent_type` arg. Context is **isolated**: the subagent starts fresh, the only
  channel in is the prompt string, and only its final result returns.
- **Persistence (two layers):** every subagent writes its full conversation to a
  durable transcript (`agent-<id>.jsonl`), cleaned up after `cleanupPeriodDays`
  (default **30 days**). A separate, perishable session-scoped handle lets a
  finished subagent be **resumed** (multi-turn continuity). Isolation always holds;
  the transcript always persists; resume is opt-in.

This maps almost 1:1 onto lite-agent: an `AgentLoader` is a twin of `SkillLoader`;
the durable transcript is the existing `jsonlStore` swept by `sweepStale` (whose
30-day default already matches); resume is the kernel's existing
`store.load(sessionId)` prepend.

## Directory layout

Extends the existing per-project home, mirroring the skills dirs exactly:

```
~/.lite-agent/
  agents/<name>.md             # user/global subagent definitions
  projects/<hash>/
    sessions/
      agent-<type>-<id>.jsonl  # durable subagent transcript (resumable)
<workdir>/.lite-agent/
  agents/<name>.md             # project subagent definitions (override global)
```

- **global** `globalAgentsDir = join(home, "agents")`
- **project** `projectAgentsDir = join(resolve(workdir), ".lite-agent", "agents")`
- precedence (project overrides global on name collision), plus an optional
  explicit `agentsDir` option appended last (overrides both) — same ordering rule
  as `SkillLoader`.

## Data model (`sdk/src/agents/types.ts`)

```ts
interface AgentDefinition {
  name: string;        // from frontmatter `name`, else filename (sans .md)
  description: string;  // when to use it — surfaced to the main agent
  tools?: string[];     // allow-list; absent = inherit the parent's tool set
  model?: string;       // override modelName (reuses the same ModelProvider)
  body: string;         // the subagent's system prompt
  path: string;         // source file (diagnostics)
}
```

`tools`/`model` reuse the parent `ModelProvider` — `model` only overrides the
request-time `modelName` (works for the Anthropic/OpenAI providers, which are
generic over model ids). No model-registry is introduced.

## Components (all in sdk)

### 1. `paths.ts` — add the two agent dirs

```ts
export interface ProjectPaths {
  /* …existing… */
  globalAgentsDir: string;   // join(home, "agents")
  projectAgentsDir: string;  // join(resolve(workdir), ".lite-agent", "agents")
}
```

Pure path computation, no fs side effects (as today).

### 2. `agents/loader.ts` — `AgentLoader`

A near-twin of `SkillLoader`: walk each dir (later dirs override earlier on name
collision), parse each `*.md` with `gray-matter`, `name` from frontmatter or
filename.

```ts
class AgentLoader {
  constructor(dirs: string | string[]);
  names(): string[];
  get(name: string): AgentDefinition | null;
  list(): AgentDefinition[];
  getDescriptions(): string;   // "  - name: description" lines, for the system prompt
}
```

`tools` frontmatter may be a YAML list or a comma-separated string (normalize to
`string[]`); a missing/blank `tools` → `undefined` (inherit).

### 3. `tools/agent.ts` — the `Agent` tool (batch + parallel)

A factory closing over an injected `spawn` + the loader. The schema is a **batch**:
one dispatch is an array of one; parallelism comes from multiple entries in a single
call (chosen because `runKernel` runs tool calls **sequentially** and changing that
would reshape a core contract — parallelism lives in the sdk tool, core untouched).

```ts
const MAX_CONCURRENCY = 5;   // bound concurrent child kernels

interface SpawnOptions { signal: AbortSignal; sessionId: string; }
type Spawn = (def: AgentDefinition, prompt: string, opts: SpawnOptions) => Promise<string>;

function agentTool(opts: { loader: AgentLoader; spawn: Spawn }): Tool;

// schema:
z.object({
  tasks: z.array(z.object({
    subagent_type: z.string(),
    prompt: z.string(),
    description: z.string().optional(),
    resume: z.string().optional(),     // a prior agentId to continue
  })).min(1),
})
```

Execution:
- For each task, look up `subagent_type`. Unknown type → that entry resolves to an
  error string listing available types (does **not** fail the batch).
- Allocate `sessionId = resume ?? `agent-${sanitize(type)}-${shortId()}``
  (`shortId` = 8 hex chars from `crypto.randomBytes`; `sanitize` =
  `replace(/[^a-zA-Z0-9_-]/g, "_")`, matching the store).
- Run all tasks with bounded concurrency (`MAX_CONCURRENCY`) via `Promise.allSettled`.
- Aggregate into one attributed tool-result string, each block headed by its index,
  type, and **`agentId`** (so the model gets a handle to `resume` later):

  ```
  ## subagent[0] researcher (agentId: agent-researcher-1a2b3c4d)
  <final text>

  ## subagent[1] reviewer (agentId: agent-reviewer-…)
  Error: <message>
  ```

Tool description guides the model: delegate large/context-heavy subtasks here
instead of inline; pass multiple entries in one call to run independent subtasks in
parallel; mark which agent type fits via its description.

### 4. Wiring (`createLiteAgent.ts`, `query.ts`, `system.ts`)

New options (default **on**, overridable):

| option | default | effect |
|---|---|---|
| `agents?: boolean` | `true` | build `AgentLoader`; register the `Agent` tool **iff ≥1 definition exists** |
| `agentsDir?: string` | — | extra dir appended last (overrides global+project) |
| `subagentPermission?: PermissionPolicy` | — (lenient: no gate) | optional policy applied to subagent runs |

In `createLiteAgent`, **only when `cfg.agents !== false`**, build the loader from
`paths.globalAgentsDir` + `paths.projectAgentsDir` + optional `cfg.agentsDir` (so a
child spawned with `agents: false` skips the fs walk entirely — and gets no `Agent`
tool, enforcing no recursion). If the loader then has names, define `spawn` and push
`agentTool({ loader, spawn })` (subject to the existing `allowedTools`/
`disallowedTools` filter, so it's named `Agent`).

`spawn(def, prompt, { signal, sessionId })` re-invokes `createLiteAgent` for the
child and runs it to completion, returning `RunResult.text`:

```ts
const spawn: Spawn = async (def, prompt, { signal, sessionId }) => {
  const child = createLiteAgent({
    ...cfg,
    system: `You are the "${def.name}" subagent operating in ${cfg.workdir}. `
          + `Return your final answer as your last message.\n\n${def.body}`,
    modelName: def.model ?? cfg.modelName,
    allowedTools: def.tools ?? cfg.allowedTools,   // def.tools restricts; absent = inherit
    agents: false,           // no recursion (child has no Agent tool)
    cleanup: false,          // parent already swept at startup
    permission: cfg.subagentPermission,            // undefined → lenient (no gate)
    onApproval: undefined,   // don't share the interactive handler (avoids interleaving)
    // sessions/spill/tasks stay default-on → durable transcript + SHARED task list
  });
  const r = await child.send([{ role: "user", content: prompt }], { signal, sessionId });
  return r.text;
};
```

`query` threads `agents`, `agentsDir`, `subagentPermission` through.

`system.ts` gains a `## Subagents` section (only when subagents exist), listing
available types + descriptions and instructing the agent to delegate large/
independent subtasks (and to batch them for parallelism), mirroring the `## Skills`
section.

## Execution model: parallel fan-out

- One `Agent` call with N `tasks` runs N child kernels concurrently, capped at
  `MAX_CONCURRENCY`, aggregated with `Promise.allSettled` (one failure ≠ batch
  failure). A single task is just N=1.
- **Isolation**: each child starts from `[{ role: "user", content: prompt }]` only
  (resume prepends that child's own prior transcript via the kernel's
  `store.load`); the parent conversation is never passed in. Child events are
  consumed inside the tool; the parent UI sees only the normal `tool_use`/
  `tool_result` for the `Agent` call — so the core `AgentEvent` union is untouched.
- **Abort**: `ctx.signal` is passed to every child; children observe it at turn
  boundaries.
- **Concurrency safety** (already in place): the task store uses `proper-lockfile`;
  the spill store is content-addressed; each child has a distinct `sessionId` →
  distinct transcript file. So children may share the project task list and spill
  dir safely.

## Persistence & resume

- Each child run persists via the default `jsonlStore` under `paths.sessionsDir`,
  keyed by its `sessionId` → a durable `agent-<type>-<id>.jsonl`, swept by the
  existing `sweepStale` (30-day default, matching Claude Code).
- **Resume**: pass a prior `agentId` as a task's `resume`; the kernel's existing
  `store.load(sessionId)` prepends that child's history, so it continues with full
  context. The `Agent` result always reports each child's `agentId` for this.

## Permission posture for subagents (lenient by default)

Parallel children share the parent's handlers, and an interactive approval handler
(e.g. the example CLI's single-slot `pendingApproval`) cannot service concurrent
prompts. Therefore, **by default subagents run with no permission gate** (default
`allow`) and **do not inherit the parent's `onApproval`** — the OS **sandbox still
wraps every bash command** (defense-in-depth is preserved). An integrator who wants
subagents gated passes `subagentPermission` (use `allow`/`deny` only, not `ask`,
under parallel fan-out). This is documented as a known limitation: interactive
`ask` approvals do not compose with parallel subagents.

## Behavior change

`createLiteAgent`/`query` gain an `Agent` tool when subagent definitions exist
(default on). No existing tool changes. No new runtime dependency (reuses
`gray-matter`, `proper-lockfile`, `jsonlStore`, `sweepStale`). Documented in a
changeset; minor version bump (the four packages are fixed-versioned together).

## Testing plan (TDD)

- **loader**: load from a dir; global+project precedence (project overrides global);
  `name` fallback to filename; `description`/`model` parsed; `tools` as list and as
  comma-string normalize to `string[]`; missing `tools` → `undefined`; unknown
  `get` → null; `getDescriptions` format.
- **Agent tool** (injected fake `spawn`): unknown `subagent_type` → that entry is an
  error listing types, batch still returns others; a single task returns the child's
  final text attributed with its `agentId`; **isolation** — `spawn` receives only the
  prompt (assert the prompt passed through, parent messages absent); `resume` reuses
  the given sessionId; **parallel** — N tasks all run (assert all N spawn calls and
  all N results aggregated); one child throwing → its block shows the error, others
  succeed.
- **wiring** (`LITE_AGENT_HOME` → tmpdir, agent `.md` written to the project dir):
  `Agent` tool present iff a definition exists; `agents: false` → absent;
  `agentsDir` selects an extra dir; system prompt lists subagent types; a subagent
  run's transcript file appears under `sessionsDir`; child shares the task list
  (a task created by the child is visible to the parent store).
- **permission**: default spawn builds the child with no permission middleware and
  no `onApproval`; `subagentPermission` set → applied to the child.

## Out of scope (future)

- Kernel-level parallelism (multiple independent `Agent` tool_use blocks running
  concurrently) — parallelism stays inside the batch tool; core untouched.
- Subagents spawning subagents (depth > 1); `disallowedTools`/`permissionMode`/
  `maxTurns`/`memory` frontmatter fields; agent teams / `SendMessage`-style live
  hand-off.
- Streaming child events up to the parent UI (a new `AgentEvent` variant) — children
  run quietly, returning only final text.
- A concurrency option (`MAX_CONCURRENCY` is an internal constant for now).
