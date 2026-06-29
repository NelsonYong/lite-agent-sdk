# Part A — Library Swaps (p-limit + picomatch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace two hand-rolled utilities with mature, well-tested libraries — the two concurrency worker-pools (`runToolPool` in core, `runPool` in sdk) with `p-limit`, and the fragile hand-rolled permission glob (`globToRegExp`) with `picomatch` — with zero observable behavior change for existing tool-name patterns.

**Architecture:** Pure internal refactor. No public API changes, no new exports. `runToolPool`/`runPool` are module-private helpers used at exactly one call site each; both are deleted and inlined as `pLimit(n)` + `Promise.all(map)` (which preserves input-ordered results while capping concurrency). `policy()` swaps its `RegExp[]` matchers for `picomatch` matcher functions. The existing test suite is the regression gate; one new characterization test pins the glob anchoring property that is currently implicit.

**Tech Stack:** TypeScript 6 (strict, ESM, `moduleResolution: Bundler`), pnpm workspace, vitest, tsup. New runtime deps: `p-limit` (pure ESM, default export), `picomatch` (CJS, default-imported — same pattern as the existing `gray-matter` import; Bundler resolution supplies the synthetic default).

---

## Background / Why this is safe

- **Concurrency pools.** Both `runToolPool` (`packages/core/src/kernel.ts:199-216`) and `runPool` (`packages/sdk/src/tools/agent.ts:85-97`) implement the identical "shared cursor, N workers, input-ordered results" algorithm. `p-limit` provides exactly this: `Promise.all(items.map(x => limit(() => fn(x))))` caps in-flight work at `n` and `Promise.all` preserves input order regardless of completion order. The callbacks at both call sites (`runCall`, `runOne`) already catch their own errors and never reject, so `Promise.all` will not reject — identical to today.
- **Permission glob.** `globToRegExp` (`packages/core/src/permission.ts:14-17`) escapes regex metachars then turns `*` into `.*`, full-string anchored. `picomatch(pattern, { dot: true })` is whole-string anchored, treats a plain name as an exact match, and `*` matches any run of chars — equivalent for the only patterns in use (`Bash`, `write_*`, `mcp__*`, `*`). `picomatch` additionally understands `{a,b}` brace and `[...]` class globs; that is a superset, not a regression, and the new characterization test plus the existing tests lock the behavior we care about.

**Risk note (state explicitly, do not silently absorb):** `picomatch` interprets more glob metacharacters than the old escape-everything-but-`*` matcher. A permission pattern that *intentionally* contained a literal `{`, `[`, `?`, or `!` would now be parsed as a glob operator. No such pattern exists in this repo or its tests, and tool names are `[A-Za-z0-9_]`-shaped, so this is acceptable — but it is a real semantic widening, recorded here and in the changeset.

## File Structure

- `packages/core/package.json` — add `p-limit`, `picomatch` to `dependencies`; `@types/picomatch` to `devDependencies`.
- `packages/core/src/permission.ts` — delete `globToRegExp`; `policy()` uses `picomatch` matchers.
- `packages/core/src/kernel.ts` — delete `runToolPool`; inline `pLimit` at its one call site.
- `packages/core/test/permission.test.ts` — add one characterization test (glob anchoring).
- `packages/sdk/package.json` — add `p-limit` to `dependencies`.
- `packages/sdk/src/tools/agent.ts` — delete `runPool`; inline `pLimit` at its one call site.
- `.changeset/part-a-library-swaps.md` — patch changeset (created; **not** versioned/published here).

> **Build choreography:** each package's own tests import its `src` directly (e.g. `permission.test.ts` → `../src/permission`), so core's tests need no rebuild. Cross-package imports read built `dist/` (`agent-tool.test.ts` imports `@lite-agent/core`), so the final gate runs `pnpm -r build` first. New deps must be `pnpm add`ed (Task 1) before any swap compiles.

> **Branch:** the lite-agent repo is currently on `main`. Do this work on a feature branch (e.g. `feat/part-a-lib-swaps`); do not commit to `main` directly.

---

### Task 1: Add the dependencies

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/sdk/package.json`

- [ ] **Step 1: Add the libraries via pnpm (auto-resolves latest compatible versions)**

Run from the repo root:

```bash
pnpm --filter @lite-agent/core add p-limit picomatch
pnpm --filter @lite-agent/core add -D @types/picomatch
pnpm --filter @lite-agent/sdk add p-limit
```

- [ ] **Step 2: Verify the manifests**

Run: `cat packages/core/package.json packages/sdk/package.json | grep -E "p-limit|picomatch"`
Expected: `core` lists `p-limit` and `picomatch` under `dependencies` and `@types/picomatch` under `devDependencies`; `sdk` lists `p-limit` under `dependencies`. (`p-limit` should resolve to v6+, ESM; `picomatch` to v4.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json packages/sdk/package.json pnpm-lock.yaml
git commit -m "build: add p-limit and picomatch deps"
```

---

### Task 2: Swap the permission glob to picomatch

**Files:**
- Modify: `packages/core/src/permission.ts:14-25`
- Test: `packages/core/test/permission.test.ts`

- [ ] **Step 1: Write the failing/characterization test FIRST (passes on current code too)**

Add to `packages/core/test/permission.test.ts`, after the existing `policy:` tests (around line 39):

```ts
test("policy: glob is whole-string anchored (no partial matches)", () => {
  const p = policy({ ask: ["write_*"], deny: ["bash"] });
  // '*' matches a trailing run of chars...
  expect(p.check({ id: "1", name: "write_file", input: {} }, { sessionId: "s" })).toBe("ask");
  // ...but the pattern is anchored at the start: a prefix before it does NOT match.
  expect(p.check({ id: "1", name: "prewrite_file", input: {} }, { sessionId: "s" })).toBe("allow");
  // a plain (non-glob) pattern is an EXACT match, not a substring/prefix match.
  expect(p.check({ id: "1", name: "bashx", input: {} }, { sessionId: "s" })).toBe("allow");
});
```

- [ ] **Step 2: Run it against the CURRENT (hand-rolled) implementation to confirm it captures real behavior**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: PASS (the old `^write_.*$` / `^bash$` regexes already satisfy this). This proves the test is a true characterization, not a behavior change.

- [ ] **Step 3: Replace the implementation**

In `packages/core/src/permission.ts`, add the import at the top (with the other imports, before the `PolicyOptions` interface):

```ts
import picomatch from "picomatch";
```

Delete the `globToRegExp` function (lines 13-17, including its comment) and rewrite the head of `policy()` (lines 19-25). The function should read:

```ts
export function policy(opts: PolicyOptions = {}): PermissionPolicy {
  // Match tool names as globs via picomatch: whole-string anchored, '*' wildcard,
  // plus brace/character-class support. dot:true keeps '*' matching every name.
  const compile = (pats?: string[]): picomatch.Matcher[] =>
    (pats ?? []).map((p) => picomatch(p, { dot: true }));
  const deny = compile(opts.deny);
  const ask = compile(opts.ask);
  const allow = compile(opts.allow);
  const fallback: Decision = opts.default ?? "allow";
  const hit = (ms: picomatch.Matcher[], name: string) => ms.some((m) => m(name));
```

Leave the `return { check(call) { ... } }` body below unchanged. (If `@types/picomatch` in your installed version does not expose `picomatch.Matcher`, drop the two `: picomatch.Matcher[]` annotations and let inference do the work.)

- [ ] **Step 4: Run the full permission suite**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: PASS — all pre-existing tests (exact allow/ask/deny, `write_*` wildcard, deny>ask>allow precedence, default, middleware gating, approval serialization) plus the new anchoring test.

- [ ] **Step 5: Typecheck core**

Run: `pnpm --filter @lite-agent/core typecheck`
Expected: clean (confirms the `picomatch` default import + `Matcher` type resolve under Bundler resolution).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/permission.ts packages/core/test/permission.test.ts
git commit -m "refactor(core): permission glob uses picomatch instead of hand-rolled regex"
```

---

### Task 3: Swap the kernel tool-pool to p-limit

**Files:**
- Modify: `packages/core/src/kernel.ts:169` and delete `packages/core/src/kernel.ts:199-216`

- [ ] **Step 1: Add the import**

At the top of `packages/core/src/kernel.ts`, add (with the other imports):

```ts
import pLimit from "p-limit";
```

- [ ] **Step 2: Replace the call site**

Change line 169 from:

```ts
    const outcomes = await runToolPool(calls, cfg.maxParallelTools ?? 10, runCall);
```

to:

```ts
    const limit = pLimit(Math.max(1, cfg.maxParallelTools ?? 10));
    const outcomes = await Promise.all(calls.map((call) => limit(() => runCall(call))));
```

(`Math.max(1, …)` preserves the old guard — `p-limit` throws on a concurrency of 0, and `maxParallelTools` could be 0.)

- [ ] **Step 3: Delete the now-unused helper**

Remove the `runToolPool` function and its doc comment (lines 199-216 — the block starting `/** Run \`fn\` over \`calls\` … */` through the closing brace).

- [ ] **Step 4: Run the kernel suite — the existing concurrency tests are the regression gate**

Run: `pnpm --filter @lite-agent/core test -- kernel`
Expected: PASS. Specifically these must stay green (they pin exactly what `p-limit` must preserve):
- `"multiple tool calls in one turn run concurrently"` → `maxInFlight === 2`
- `"maxParallelTools: 1 forces sequential execution"` → `maxInFlight === 1`
- `"tool_result events and result blocks stay in input order regardless of completion order"` → results stay `["SLOW","FAST"]`
- `"a wrapToolCall middleware that throws yields an error result without stranding siblings"`

- [ ] **Step 5: Typecheck core**

Run: `pnpm --filter @lite-agent/core typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/kernel.ts
git commit -m "refactor(core): kernel tool pool uses p-limit instead of hand-rolled worker pool"
```

---

### Task 4: Swap the Agent tool's pool to p-limit

**Files:**
- Modify: `packages/sdk/src/tools/agent.ts:77` and delete `packages/sdk/src/tools/agent.ts:85-97`

- [ ] **Step 1: Add the import**

At the top of `packages/sdk/src/tools/agent.ts`, add (with the other imports):

```ts
import pLimit from "p-limit";
```

- [ ] **Step 2: Replace the call site**

Change line 77 from:

```ts
      const results = await runPool(tasks, MAX_CONCURRENCY, runOne);
```

to:

```ts
      const limit = pLimit(MAX_CONCURRENCY);
      const results = await Promise.all(tasks.map((t) => limit(() => runOne(t))));
```

- [ ] **Step 3: Delete the now-unused helper**

Remove the `runPool` function and its doc comment (lines 85-97 — the block starting `/** Run \`fn\` over \`items\` … */` through the closing brace).

- [ ] **Step 4: Run the Agent-tool suite**

Run: `pnpm --filter @lite-agent/sdk test -- agent-tool`
Expected: PASS. In particular:
- `"parallel: every task runs and results are aggregated in order"` → `a:1` before `b:2` before `c:3`
- `"each task surfaces as its own tool_use + tool_result (subagent as a tool call)"` → names `["a","b"]`, ordered
- `"one task throwing surfaces its error; siblings still succeed"`

- [ ] **Step 5: Typecheck sdk**

Run: `pnpm --filter @lite-agent/sdk typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/tools/agent.ts
git commit -m "refactor(sdk): Agent tool pool uses p-limit instead of hand-rolled worker pool"
```

---

### Task 5: Full gate + changeset

**Files:**
- Create: `.changeset/part-a-library-swaps.md`

- [ ] **Step 1: Run the full workspace gate (rebuilds dist in topo order first)**

Run: `pnpm -r build && pnpm -r test && pnpm -r typecheck`
Expected: build OK; all tests pass (the prior 274-test baseline, plus the 1 new permission test = 275); typecheck clean across every package. This is the authoritative cross-package check — `agent-tool.test.ts` imports `@lite-agent/core` from its freshly built `dist/`.

- [ ] **Step 2: Create the changeset**

Create `.changeset/part-a-library-swaps.md`:

```markdown
---
"@lite-agent/core": patch
"@lite-agent/sdk": patch
---

Replace hand-rolled internals with maintained libraries: the two concurrency worker-pools (kernel tool pool, Agent subagent pool) now use `p-limit`, and the permission tool-name matcher uses `picomatch` instead of a hand-rolled glob→regexp. Behavior is unchanged for existing tool-name patterns; the permission matcher additionally supports brace (`{a,b}`) and character-class (`[…]`) globs.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/part-a-library-swaps.md
git commit -m "chore: changeset for p-limit/picomatch library swaps"
```

> **Deferred (needs explicit user consent — do NOT run as part of this plan):** `pnpm version` (bumps the fixed group core/sdk/provider/sandbox-anthropic to the next patch and writes CHANGELOGs) and any publish. When versioning later, watch for `@lite-agent/checkpoint-sqlite` getting a cascade bump from its core dependency and pin it back, consistent with the prior decision to keep it independently versioned.

---

## Self-Review

- **Spec coverage:** Both Part-A items are covered — concurrency pools (Tasks 3 + 4, both call sites) and permission glob (Task 2). Dependencies (Task 1) and changeset/gate (Task 5) bookend them.
- **Placeholder scan:** No TBD/TODO; every code step shows the exact import, replacement, and deletion; every test step has an exact command and expected result.
- **Type consistency:** `pLimit` is the default import used identically in `kernel.ts` and `agent.ts`. `picomatch.Matcher` is used consistently in `permission.ts` with a documented inference fallback. Call-site signatures (`runCall(call)`, `runOne(t)`) match the deleted helpers' callbacks.
- **No new tests beyond the one characterization test:** intentional — the existing `kernel.test.ts` concurrency/order tests and `agent-tool.test.ts` order test already pin the properties `p-limit` must preserve; adding more would be redundant.
- **Ordering:** deps (Task 1) precede all swaps so each compiles; the characterization test (Task 2) is proven against the old code before the swap; the full gate (Task 5) is last.
