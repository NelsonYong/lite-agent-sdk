# Design: `.lite-agent` path conventions, default persistence, and cleanup

Date: 2026-06-23
Status: approved (pending spec review)

## Goal

Give `lite-agent-sdk` a Claude Code–style home so persistence "just works":
a global `~/.lite-agent` home, per-project runtime artifacts, two-source skill
loading (global + project), and age-based auto-cleanup. `createLiteAgent` ships
these **on by default** (overridable), like Claude Code.

All new code lives in the **sdk** package (filesystem = batteries). **core is
unchanged** — the `Store`, `Compactor`/`SpillStore`, and compaction blocks it
already exposes are sufficient.

## Directory layout

```
~/.lite-agent/                     # global home (override: $LITE_AGENT_HOME)
  skills/                          # global skills (SKILL.md tree)
  projects/<hash>/                 # per-project runtime artifacts
    spill/                         # spilled tool_result blobs (<sha1>.txt)
    sessions/                      # session transcripts (<sessionId>.jsonl)

<project>/.lite-agent/
  skills/                          # project skills (SKILL.md tree)
```

- **Global home**: `$LITE_AGENT_HOME` if set, else `~/.lite-agent`.
- **Project root**: `createLiteAgent`'s existing `workdir` (`query`'s `cwd`).
  No git/.lite-agent walk-up — keep it simple.
- **`<hash>`**: first 16 hex chars of `sha1(resolve(workdir))`. Stable per
  absolute project path; partitions runtime artifacts the way Claude Code does.

## Components (all in sdk)

### 1. `paths.ts`

```ts
export function liteAgentHome(): string                  // $LITE_AGENT_HOME || ~/.lite-agent
export function projectHash(workdir: string): string     // sha1(resolve(workdir)).slice(0,16)
export interface ProjectPaths {
  home: string; hash: string;
  spillDir: string; sessionsDir: string;
  globalSkillsDir: string; projectSkillsDir: string;
}
export function resolveProjectPaths(opts: { workdir: string; home?: string }): ProjectPaths
```

Pure path computation — no fs side effects (dirs are created lazily by the
stores that write to them).

### 2. Skills: global + project merge

`SkillLoader` is extended to accept an **ordered list of directories**; later
dirs override earlier ones on name collision.

```ts
new SkillLoader(dirs: string | string[])   // string kept for back-compat
```

`createLiteAgent` loads `[globalSkillsDir, projectSkillsDir, ...(skillsDir ? [skillsDir] : [])]`.
Precedence (low→high): **global < project < explicit `skillsDir`**. Missing dirs
are skipped silently.

### 3. Default persistence in `createLiteAgent`

New options (all default **on**, individually overridable):

| option | default | effect |
|---|---|---|
| `home?: string` | `liteAgentHome()` | override global home |
| `sessions?: boolean` | `true` | if no explicit `store`, use `jsonlStore({ dir: sessionsDir })` |
| `spill?: boolean \| { budgetBytes?: number }` | `true` | `fileSpillStore({ dir: spillDir })` + register `read_spilled` + feed the default compactor's `spillStore` |
| `compactor?: Compactor \| false` | `defaultCompactor({ spillStore? })` | `false` disables compaction; an explicit `Compactor` overrides |
| `cleanup?: boolean \| { maxAgeDays?: number }` | `true` (30 days) | run `sweepStale` once at construction |

Interactions / precedence:
- explicit `store` > `sessions` flag; `sessions: false` → no store.
- explicit `compactor` > default; `compactor: false` → no compaction middleware,
  no reactive net. The `spillStore` is auto-injected only into the **default**
  compactor; if you pass your own `compactor`, wire its `spillStore` yourself
  (the `fileSpillStore` + `read_spilled` are still created so the tool works).
- `spill: false` → no `fileSpillStore`, no `read_spilled`; the default compactor
  then runs without a `spillStore`.
- Compaction default = **deterministic only** (`defaultCompactor`: snip + micro
  + budget-spill). No LLM call ever happens unless the user passes
  `llmCompactor(...)` explicitly. `reactiveCompaction()` is added whenever
  compaction is on (same as today).

`query` inherits all defaults (it delegates to `createLiteAgent`; `cwd` = root).

### 4. Cleanup: `sweepStale`

```ts
export function sweepStale(opts?: { home?: string; maxAgeDays?: number }): void
```

Walks `<home>/projects/*/{spill,sessions}` and deletes files whose mtime is
older than `maxAgeDays` (default 30). **Global sweep** (reclaims abandoned
projects), synchronous, wrapped in try/catch so a failure never blocks agent
startup. Called once during `createLiteAgent` construction unless `cleanup: false`.

## Testability (required by default-on)

Default-on writes to `~/.lite-agent` and sweeps it — unacceptable from the test
suite. Mitigation:

- `liteAgentHome()` honors `$LITE_AGENT_HOME`.
- A vitest `setupFiles` entry in the sdk package sets `process.env.LITE_AGENT_HOME`
  to a fresh `mkdtemp` dir for the whole suite, isolating all disk effects.
- Existing createLiteAgent tests keep passing: default compaction is a no-op for
  short runs (snip needs >50 msgs, micro needs >3 tool_results); the extra
  `read_spilled` tool is filtered by `allowedTools` like any other.

## Behavior change

This flips `createLiteAgent`/`query` from "no disk" to "persists sessions +
spills + cleans by default." Documented in the changeset; all behaviors are
opt-out. Minor version bump (additive options, changed defaults).

## Testing plan (TDD)

- `paths.ts`: home env override; hash stability/determinism; resolved subpaths.
- `SkillLoader`: multi-dir load; later dir overrides earlier; missing dirs skipped.
- `sweepStale`: deletes files older than cutoff, keeps fresh ones, tolerates a
  missing home, sweeps across multiple project dirs.
- `createLiteAgent` defaults (with `LITE_AGENT_HOME` → tmpdir):
  - sessions on by default → transcript written under `sessionsDir`;
    `sessions: false` → nothing written.
  - spill on by default → `read_spilled` registered; `spill: false` → not.
  - `compactor: false` → no compaction event even when it would trigger.
  - skills: a project skill shadows a same-named global skill.
  - `cleanup: false` → no sweep.

## Out of scope (future)

- Project-root discovery by walking up to `.git`/`.lite-agent`.
- Global config file under `~/.lite-agent`.
- Size-cap/LRU cleanup (only age-based now).
