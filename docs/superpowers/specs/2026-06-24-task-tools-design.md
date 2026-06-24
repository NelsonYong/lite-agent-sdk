# Design: replace the `todo` tool with a persistent Tasks API

Date: 2026-06-24
Status: approved

## Goal

Replace the in-memory `todo` tool with a **persistent, four-tool Tasks API**
that mirrors the model Claude Code / the Claude Agent SDK moved to (TS Agent SDK
`0.3.142` / Claude Code `v2.1.142`, Jan 2026): `TaskCreate` / `TaskUpdate` /
`TaskGet` / `TaskList`, where each task is an individual JSON file that survives
compaction, restart, and is shared across sessions of the same project. A single
main agent uses these tools; concurrent access is made safe now because subagents
are planned later.

All new code lives in the **sdk** package (filesystem = batteries). **core is
unchanged** — the existing `Middleware` (`wrapModelCall`), `ToolContext`, and
path helpers are sufficient.

## Background: why this shape

| | TodoWrite (current `todo.ts`) | Tasks API (this design) |
|---|---|---|
| Call shape | replace the whole list each call | granular create / update per item |
| Storage | in-memory, lost on restart/compaction | one JSON file per task, persistent |
| Identity | caller-supplied `id`, flat `text` | server-allocated sequential `id`, `subject`+`description` |
| Extras | `status` only; max-1 `in_progress` | `activeForm`, dependencies, `owner`, `metadata` |
| Visibility | manual | per-turn reminder re-injection |

The current `todo` tool is essentially in-memory TodoWrite. We are moving to the
newer model wholesale.

## Directory layout

Extends the existing per-project home (see `2026-06-23-lite-agent-paths-design.md`):

```
~/.lite-agent/projects/<hash>/
  tasks/<listId>/          # one directory per task list
    1.json                 # one file per task (sequential id)
    2.json
    .lock                  # proper-lockfile mutex (created lazily)
```

- **`<hash>`**: existing `projectHash(workdir)` — partitions per project, so the
  default list is **shared across all sessions of the same project**.
- **`<listId>`**: `taskListId` option → `$LITE_AGENT_TASK_LIST_ID` → `"default"`
  (mirrors `CLAUDE_CODE_TASK_LIST_ID`). Lets one project hold multiple lists, or
  two workdirs share a list by setting the same id.

## Data model (`sdk/src/tasks/types.ts`)

```ts
type TaskStatus = "pending" | "in_progress" | "completed";

interface Task {
  id: string;             // server-allocated sequential: "1", "2", ...
  subject: string;        // imperative title
  description: string;
  activeForm?: string;    // present-continuous, shown while in_progress
  status: TaskStatus;
  owner?: string;
  blockedBy: string[];    // ids that must complete before this can start
  blocks: string[];       // reverse edges, auto-maintained
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
```

Decisions baked in:
- **No "only one `in_progress`" constraint.** That was a TodoWrite-era rule; the
  Tasks API allows multiple in-flight tasks (and we want this for subagents).
- **Dependencies are bidirectional and auto-maintained.** `addBlockedBy: ["1"]`
  on task `2` also appends `"2"` to task `1`'s `blocks`.
- **Cycle detection.** On any dependency-adding update, traverse the dependency
  graph; if the edge would create a cycle (A→…→A, an unresolvable deadlock),
  reject the update with an error. One graph walk; cheap.

## Components (all in sdk)

### 1. `paths.ts` — add `tasksDir`

```ts
export interface ProjectPaths {
  /* …existing… */
  tasksDir: string;   // join(projectDir, "tasks")
}
```

Pure path computation, no fs side effects (as today). The `<listId>` subdir is
joined by the store, not here.

### 2. `tasks/store.ts` — `fileTaskStore`

Mirrors `fileSpillStore`/`jsonlStore` (sanitized filenames, lazy `mkdirSync`),
but **mutations are async** because they take a cross-process lock.

```ts
interface TaskStore {
  create(input: { subject; description; activeForm?; metadata? }): Promise<Task>;
  update(input: { taskId; status?; subject?; description?; activeForm?;
                  owner?; addBlockedBy?; addBlocks?; metadata? }): Promise<Task>;
  get(taskId: string): Task | null;        // lock-free read
  list(): Task[];                          // lock-free read, id-sorted
  render(): string;                        // lock-free, for the reminder
}

export function fileTaskStore(opts: { dir: string; listId: string }): TaskStore
```

**Concurrency model** (required — subagents are planned):
- **Mutex**: one lock per list, via **`proper-lockfile`** (mature, npm-grade,
  handles stale-lock reclamation + retry — chosen over hand-rolling per the
  project's "prefer libraries" principle). `create` and `update` acquire the
  lock around their full read-modify-write, then release. Zero-dep fallback if
  we ever drop the dep: an atomic `mkdir` mutex.
- **id allocation under the lock**: scan `*.json`, take `max(numericId)+1`. Doing
  this inside the lock removes the duplicate-id race entirely.
- **Atomic single-file writes**: write `<id>.json.tmp` then `rename` (atomic on
  POSIX) so a concurrent reader never sees a half-written file.
- **Reads are lock-free**: `get`/`list`/`render` just read+parse. Because writes
  are atomic per file, a read never tears; the only possible skew is reading
  mid-multi-file-update (e.g. `1.blocks` updated, `2.blockedBy` not yet) — benign
  for a task list the model re-reads next turn. (Windows note: cross-process
  rename-over-existing is POSIX-clean; the runtime target is macOS/Linux.)

### 3. `tools/task.ts` — the four tools

Schemas and descriptions track the Claude Code tools verbatim (including the
guidance text: use for 3+ step / non-trivial work; mark `completed` only when
**FULLY** accomplished). This guidance is advisory prompt text — nothing about
the `in_progress` count is *enforced* by the store (see the data-model decision).
All four close over a single `TaskStore`.

| tool | input | returns |
|---|---|---|
| `TaskCreate` | `subject, description, activeForm?, metadata?` | new task id + confirmation |
| `TaskUpdate` | `taskId, status?, subject?, description?, activeForm?, owner?, addBlockedBy?, addBlocks?, metadata?` | updated task summary |
| `TaskGet` | `taskId` | full task detail (incl. description, dep graph) |
| `TaskList` | `{}` | compact id-sorted list with status + blockedBy |

Errors return `isError` tool results (kernel already wraps thrown errors): unknown
`taskId`, dependency cycle, unknown referenced id in `addBlockedBy`/`addBlocks`.

### 4. `tasks/reminder.ts` — per-turn re-injection

A `wrapModelCall` middleware (same shape as `reactiveCompaction`) that injects the
current task list as a trailing `<system-reminder>` **only into the encoded
request**, never into the persisted transcript:

```ts
export function taskReminder(store: TaskStore): Middleware {
  return {
    name: "task-reminder",
    async *wrapModelCall(ctx, next) {
      const block = store.render();
      if (!block) { yield* next(); return; }      // empty list → no injection
      const saved = ctx.messages;
      ctx.messages = [...saved, { role: "user",
        content: `<system-reminder>\nCurrent tasks:\n${block}\n</system-reminder>` }];
      try { for await (const c of next()) yield c; }
      finally { ctx.messages = saved; }            // restored before assistant push / persist
    },
  };
}
```

It must sit **after** `reactiveCompaction` in the middleware array (= innermost,
closest to `codec.encode`), so the reminder is present at encode time and removed
before the kernel pushes the assistant message or calls `store.save`.

### 5. Wiring (`tools/index.ts`, `createLiteAgent.ts`, `query.ts`, `system.ts`)

- `defaultTools()`: **remove `todoTool()`**; delete `tools/todo.ts` and its export.
- New options (default **on**, overridable):

  | option | default | effect |
  |---|---|---|
  | `tasks?: boolean` | `true` | build `fileTaskStore`, register the 4 tools, add `taskReminder` to `use` |
  | `taskListId?: string` | `$LITE_AGENT_TASK_LIST_ID` ?? `"default"` | which list dir under `tasksDir` |

- In `createLiteAgent`: when `tasks !== false`, create the store from
  `paths.tasksDir` + resolved `listId`, push the four tools (subject to the
  existing `allowedTools`/`disallowedTools` filter), and append `taskReminder(store)`
  to `use` (after the compaction pair).
- `query` threads `tasks` and `taskListId` through.
- `system.ts`: replace any todo-oriented planning guidance with Task* guidance
  (plan multi-step work with `TaskCreate`/`TaskUpdate`).

## Behavior change

`createLiteAgent`/`query` swap the `todo` tool for `TaskCreate`/`TaskUpdate`/
`TaskGet`/`TaskList`, now persistent + per-turn-reminded by default. Adds a
`proper-lockfile` dependency to the sdk package. Documented in a changeset; minor
version bump (the four packages are fixed-versioned together).

## Testing plan (TDD)

- **store**: create→get→list round-trip; sequential id allocation; update of
  status / fields; bidirectional dependency maintenance; cycle detection rejects
  A→B→A; persistence round-trip (rebuild store from disk, read back); unknown id
  errors.
- **concurrency**: two `fileTaskStore` instances on the same dir creating
  concurrently allocate distinct ids (lock works); a reader during a write never
  parses a torn file.
- **reminder middleware** (via `fakeProvider`): the injected block appears in the
  request the provider sees; after `turn_end`, `ctx.messages` contains **no**
  reminder; the store transcript (`jsonlStore`) never contains the reminder;
  empty list → no injection.
- **tools**: schema parsing; unknown `taskId` → `isError`; `addBlockedBy` cycle →
  `isError`; `TaskList` renders status + blockedBy.
- **wiring** (`LITE_AGENT_HOME` → tmpdir): `todo` gone, four Task tools present;
  `tasks: false` → none registered and no reminder middleware; `taskListId`
  selects the right dir; `allowedTools` can still filter them.

## Out of scope (future)

- Subagent orchestration itself (the Task **dispatcher** tool). This design only
  makes the task store concurrency-safe so that work can land later.
- Age-based cleanup of `tasksDir` (tasks are intentional state; `sweepStale` is
  **not** extended to them).
- Windows-specific rename semantics; multi-host (network FS) locking.
- A `TaskDelete` tool (use `status` + future cleanup instead).
