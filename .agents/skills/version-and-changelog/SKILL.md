---
name: version-and-changelog
description: >-
  Bump the version and update the CHANGELOG for the packages under `packages/`
  that actually changed since the last release, following semver and the repo's
  existing changelog conventions (English). Use this whenever the user wants to
  version packages, bump a version, write or update a changelog / release notes,
  "prepare a release", "cut a version", or land pending changes into a release —
  including right after finishing a feature or fix. Only packages with real code
  changes are touched; unchanged packages keep their version and changelog
  exactly as-is. Scope is the `packages/` directory only; private, example, and
  non-published packages are ignored. This is the manual replacement for tools
  like changesets — do the versioning by hand, do not reintroduce a version tool.
---

# Version & Changelog for Changed Packages

## What this does and why

In a monorepo, a release should bump **only the packages that actually changed**,
and each bump should carry a changelog entry that a human reading the git history
a year from now can understand. Version tools (changesets, lerna) automate this
but also drag in cascades — bumping unchanged packages just because a dependency
moved. This skill does the same job by hand, deliberately, so the diff stays
minimal: touched packages get a semver-appropriate bump and a clear English
changelog note; everything else is left alone.

The single most important rule: **never modify a package that did not change.**
Not its `version`, not its `CHANGELOG.md`. If you find yourself editing a package
whose shipped code is identical to the last release, stop — that edit is wrong.

## Scope

- Only packages under `packages/`. Ignore `examples/`, tooling, root config, and
  anything marked `"private": true` or that has no version to publish.
- Internal dependencies here use `workspace:*` (or similar), which resolves at
  publish time. A dependency version moving does **not** require the dependent to
  bump. So there is no "updated dependencies" cascade — only bump a dependent if
  *its own* code changed.
- Do not `git commit`, tag, or publish unless the user explicitly asks. This skill
  edits `package.json` + `CHANGELOG.md` and stops.

## Step 1 — Find the baseline (the last release)

You need the point in history the current versions were cut at, to diff against.
In order of reliability:

1. The most recent release commit — usually a `chore(release)` / "version
   packages" commit. Find it:
   ```bash
   git log -1 --format='%H %s' --grep='release\|version packages\|bump version' -i
   ```
2. If there's no such commit, the newest version tag (`vX.Y.Z` or `<pkg>@X.Y.Z`):
   ```bash
   git tag --sort=-creatordate | head
   ```
3. If neither is clear, ask the user which commit/tag was the last release.

Call this ref `BASE`. Sanity-check it: the `version` fields in `packages/*/package.json`
at `BASE` should match today's committed versions (i.e. nothing has been released
since). If they differ, you have the wrong base — investigate before continuing.

## Step 2 — Detect which packages changed

Diff every shipped file from `BASE` to the current working tree (this captures
both committed and still-uncommitted work, which is what "since the last release"
means):

```bash
git diff --stat BASE -- packages/
```

A package **changed** if its *shipped* code changed — primarily `src/**`, plus
packaged metadata in `package.json` (exports, bin, dependencies). Judgement calls:

- **Tests, fixtures, internal docs only** (`test/**`, `*.test.ts`, README tweaks):
  these don't ship, so they don't *require* a release on their own. If a package's
  only diff is tests, it usually should **not** be bumped. Mention it and move on.
- **`CHANGELOG.md`** is your output — never treat a changelog edit as "a change
  that needs a bump."

List the changed packages and, for each, read the actual diff so your changelog
describes what really happened, not what you assume:
```bash
git diff BASE -- packages/<name>/src
```

## Step 3 — Decide the bump for each changed package (semver)

Pick the level from the *nature* of that package's changes. Conventional-commit
prefixes in the git log (`feat:`, `fix:`, `perf:`, `refactor:`) are strong hints;
the diff itself is the source of truth.

| Change in the package | Bump |
|---|---|
| Breaking API change (removed/renamed export, changed signature/behavior) | **major** — but see the 0.x note |
| New backward-compatible capability (`feat`) | **minor** |
| Bug fix, perf, internal refactor, dependency-only change (`fix`/`perf`/`refactor`/`chore`) | **patch** |

**0.x nuance (semver §4):** below `1.0.0` the public API isn't frozen. Common,
and this repo's own, practice is: features → **minor** (`0.7.0 → 0.8.0`), fixes →
**patch** (`0.7.0 → 0.7.1`), and a breaking change bumps **minor** rather than
major (major stays reserved for the eventual `1.0.0`). Follow the pattern already
visible in the package's `CHANGELOG.md` history. If a change is genuinely breaking
and the user might want to signal that loudly, surface it rather than deciding
silently.

Each package is judged independently — two changed packages can land on different
levels (one minor, one patch). That's expected; do not force them to match.

## Step 4 — Bump `version` in package.json

Edit only the `"version"` field of each changed package. Keep the exact key
formatting the file already uses.

## Step 5 — Prepend a CHANGELOG entry

**Match the format the repo already uses.** Open the package's existing
`CHANGELOG.md` and mirror its structure exactly — heading depth, section names,
bullet style — so the file stays internally consistent. Only if a package has no
`CHANGELOG.md` yet, create one using the [Keep a Changelog](https://keepachangelog.com)
convention (`## [X.Y.Z] - YYYY-MM-DD` with `### Added / Changed / Fixed / Removed`).

New entries go **at the top**, right under the `# <package name>` title, above the
previous version — changelogs read newest-first.

Write entries in **English**, describing the change from the consumer's point of
view: what they can now do, what changed, or what was fixed — with concrete API
names, paths, and options. A good entry lets a reader decide whether the release
affects them without opening the diff. Avoid bare commit subjects like "fix bug".

### Example — matching the existing changeset-style format used here

This repo's `CHANGELOG.md` files use changeset-style sections. For a package that
gained a feature and a fix, mirror it like this:

```markdown
# @lite-agent/sdk

## 0.8.0

### Minor Changes

- Add free-text steering to manual compaction: `LiteAgent.compact(instructions?)`
  forwards an instruction string to the compactor (Codex's `/compact
  <instructions>`), so a summary can be biased toward what matters.

### Patch Changes

- Generate session ids as UUID v4 via `crypto.randomUUID()` instead of the
  `s-<timestamp>-<rand>` form. Ids stay opaque, so existing sessions still
  resume/restore.

## 0.7.0

### Minor Changes
...
```

Only include the section(s) that apply — a patch-only release has just `### Patch
Changes`. Keep the one-blank-line spacing the existing entries use.

## Finish

Report a short summary: each package that changed, old → new version, and the bump
level — plus any package you deliberately left untouched (and why, e.g. "tests
only"). Then stop. Committing, tagging, and publishing are separate steps the user
drives.
