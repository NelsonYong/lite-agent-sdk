---
"@lite-agent/sdk": minor
---

feat(sdk): `.lite-agent` home, default persistence, and age-based cleanup

`createLiteAgent`/`query` adopt a Claude Code–style home (`$LITE_AGENT_HOME` || `~/.lite-agent`) and turn persistence on by default (all opt-out). This is a behavior change: `createLiteAgent`/`query` now write to disk and sweep stale files by default.

- **Paths** (`resolveProjectPaths` / `liteAgentHome` / `projectHash`): per-project runtime artifacts under `~/.lite-agent/projects/<sha1(workdir)>/{spill,sessions}`; global skills under `~/.lite-agent/skills`; project skills under `<workdir>/.lite-agent/skills`.
- **Skills**: loaded from global < project < explicit `skillsDir` (later overrides earlier). `SkillLoader`'s constructor now accepts `string | string[]`, and its public `skillsDir` field was renamed to `dirs` (no external consumer in-repo; pre-1.0).
- **Defaults** (each overridable): `sessions` → `jsonlStore`, `spill` → `fileSpillStore` + `read_spilled`, `compactor` → deterministic `defaultCompactor` (no LLM), `cleanup` → `sweepStale` (30-day sweep). Opt out via `sessions:false` / `spill:false` / `compactor:false` / `cleanup:false`; an explicit `store`/`compactor` overrides the default. New `home?` option overrides the home for both `createLiteAgent` and `query`.

> Note: cleanup sweeps by file mtime at startup. Resuming a session whose transcript has been untouched for longer than the cleanup window (30 days by default) will have that transcript swept before it loads, so its history is dropped. Active sessions bump their mtime each turn and are never at risk; raise `cleanup.maxAgeDays` or set `cleanup:false` to keep cold transcripts.

No core changes — built entirely on the existing `Store` / `SpillStore` / `Compactor` strategies.
