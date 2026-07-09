# Content-Level Enterprise Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the permission gate content/argument-level, auditable, redacting, fail-closed, dry-runnable, and composable — enterprise-grade — while keeping 100% backward compatibility with today's `policy()`/`permission()`.

**Architecture:** The `PermissionPolicy.check(call, ctx)` strategy already receives `call.input`, so this is additive. We split `core/src/permission.ts` into a `permission/` folder, teach `policy()` a declarative rule model (dot-path `MatchSpec` + operators, deny>ask>allow, legacy desugaring), add decision provenance (`PolicyVerdict`), a `permission_decision` event, a redactor for audit payloads, fail-closed enforcement + `strictPolicy`, a `dry-run` mode, and a `composePolicies` deny-wins combinator. The sdk adds thin per-tool specifier sugar and threads options through `createLiteAgent`.

**Tech Stack:** TypeScript (ESM, strict, `verbatimModuleSyntax` — value/type imports separate; `noUncheckedIndexedAccess`), vitest, picomatch (already a core dep). Core in-package tests import from `../src/...` (source) — no build needed for core tasks; the one sdk task rebuilds core first.

**Spec:** `docs/superpowers/specs/2026-07-09-content-level-permissions-design.md`
**Branch:** `feat/content-permissions`

**Backward-compat invariants (must hold at every task):**
- `policy().check` returns a **bare `Decision` string** for legacy `allow/ask/deny` name-array matches and for the `default` fallback; a **`PolicyVerdict` object** only when an explicit `rules[]` entry matches. (Existing tests assert `.toBe("allow")`.)
- The denied tool-result message stays `Error: blocked by policy` (append `: <reason>` only when a matched rule has a `description`) and `Error: denied by user`.
- `@lite-agent/core`'s `./permission` import path keeps resolving (folder `index.ts` replaces the file).

**Two scope refinements vs the spec (deliberate):**
- **Durable audit `SessionEvent` is deferred.** Persisting `permission_decision` into the session log needs a new middleware→checkpointer seam (the gate middleware has no `append` handle). v1 ships the always-emitted observational `permission_decision` event as the audit surface; durable persistence is a follow-up. No `audit` option in v1.
- **`domain()` specifier dropped.** The sdk ships no network/fetch tool to gate (YAGNI); v1 ships `bashCommand` + `filePath`. `domain()` is trivial to add when a fetch tool lands.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/permission/policy.ts` | `policy()`, rules, `MatchSpec` matcher, `PolicyOptions`, `strictPolicy`, `composePolicies` | 1,2,5,6 |
| `packages/core/src/permission/gate.ts` | `permission()` middleware: normalize verdict, provenance message, emit event, fail-closed, dry-run | 1,3,4,5 |
| `packages/core/src/permission/redact.ts` | `Redactor`, `defaultRedactor` | 4 |
| `packages/core/src/permission/index.ts` | re-exports (keeps `./permission` surface) | 1,2,4,6 |
| `packages/core/src/strategies.ts` | `PolicyVerdict`; widen `PermissionPolicy.check` return | 2 |
| `packages/core/src/events.ts` | `permission_decision` event | 3 |
| `packages/core/src/index.ts` | export new public types/fns | 2,4,6 |
| `packages/core/test/permission.test.ts` | existing + new matcher/gate tests | 1-6 |
| `packages/sdk/src/permission/specifiers.ts` | `bashCommand`, `filePath` | 7 |
| `packages/sdk/src/createLiteAgent.ts` | thread `{ redact, mode }` into `permission()` | 7 |

---

## Task 1: Split `permission.ts` into a `permission/` folder (pure refactor)

**Files:**
- Create: `packages/core/src/permission/policy.ts`, `packages/core/src/permission/gate.ts`, `packages/core/src/permission/index.ts`
- Delete: `packages/core/src/permission.ts`
- Test: `packages/core/test/permission.test.ts` (unchanged — must still pass)

- [ ] **Step 1: Create `packages/core/src/permission/policy.ts`** with the CURRENT `policy()` verbatim:

```ts
import picomatch from "picomatch";
import type { Decision, PermissionPolicy } from "../strategies";

export interface PolicyOptions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  default?: Decision;
}

export function policy(opts: PolicyOptions = {}): PermissionPolicy {
  const compile = (pats?: string[]) => (pats ?? []).map((p) => picomatch(p, { dot: true }));
  const deny = compile(opts.deny);
  const ask = compile(opts.ask);
  const allow = compile(opts.allow);
  const fallback: Decision = opts.default ?? "allow";
  const hit = (ms: Array<(name: string) => boolean>, name: string) => ms.some((m) => m(name));
  return {
    check(call): Decision {
      if (hit(deny, call.name)) return "deny";
      if (hit(ask, call.name)) return "ask";
      if (hit(allow, call.name)) return "allow";
      return fallback;
    },
  };
}
```

- [ ] **Step 2: Create `packages/core/src/permission/gate.ts`** with the CURRENT `permission()` + `denied()` verbatim (note the import paths become `../`):

```ts
import type { PermissionPolicy, ApprovalHandler } from "../strategies";
import type { Middleware, ToolCallContext } from "../middleware";
import type { ToolCall, ToolResult } from "../types";

function denied(ctx: ToolCallContext, reason: string): ToolResult {
  return { id: ctx.call.id, name: ctx.call.name, content: `Error: ${reason}`, isError: true };
}

export function permission(pol: PermissionPolicy, approval?: ApprovalHandler): Middleware {
  let lock: Promise<unknown> = Promise.resolve();
  const requestSerial = (call: ToolCall): Promise<"allow" | "deny"> => {
    const run = lock.then(() => approval!.request(call));
    lock = run.then(() => undefined, () => undefined);
    return run;
  };
  return {
    name: "permission",
    async wrapToolCall(ctx, next) {
      const decision = await pol.check(ctx.call, { sessionId: ctx.sessionId });
      if (decision === "allow") return next();
      if (decision === "deny") return denied(ctx, "blocked by policy");
      ctx.emit({ type: "approval_request", call: ctx.call });
      const resolved = approval ? await requestSerial(ctx.call) : "deny";
      ctx.emit({ type: "approval_resolved", id: ctx.call.id, decision: resolved, by: approval ? "user" : "auto" });
      return resolved === "allow" ? next() : denied(ctx, "denied by user");
    },
  };
}
```

- [ ] **Step 3: Create `packages/core/src/permission/index.ts`**:

```ts
export { policy } from "./policy";
export type { PolicyOptions } from "./policy";
export { permission } from "./gate";
```

- [ ] **Step 4: Delete the old file**

```bash
git rm packages/core/src/permission.ts
```

- [ ] **Step 5: Verify existing tests + typecheck pass unchanged**

Run: `pnpm --filter @lite-agent/core test -- permission && pnpm --filter @lite-agent/core typecheck`
Expected: PASS. The test's `import { policy, permission } from "../src/permission"` now resolves to `permission/index.ts`; `core/src/index.ts`'s `export { policy, permission } from "./permission"` likewise. No source of either changed.

- [ ] **Step 6: Commit**

```bash
git add -A packages/core/src/permission packages/core/src/permission.ts
git commit -m "refactor(core): split permission.ts into a permission/ folder"
```

---

## Task 2: Declarative rules + `MatchSpec` matcher + provenance verdict

> **Post-review corrections (shipped in `632d396` — the snippets below predate them):** (1) `matchCondition` gained a top-level `value === undefined → false` guard and an `evaluable()` helper so `not` never matches a missing or type-mismatched value (fail-closed negation); the bare `if ("not" in cond) return !matchCondition(...)` line below is the pre-fix version. (2) `deepEqual` via `JSON.stringify` was replaced with the `dequal` library (structural, key-order-insensitive).

**Files:**
- Modify: `packages/core/src/permission/policy.ts` (rewrite `policy()`)
- Modify: `packages/core/src/strategies.ts` (add `PolicyVerdict`, widen `check`)
- Modify: `packages/core/src/permission/index.ts`, `packages/core/src/index.ts` (exports)
- Test: `packages/core/test/permission.test.ts`

- [ ] **Step 1: Add `PolicyVerdict` and widen `check` in `packages/core/src/strategies.ts`**

Replace the `PermissionPolicy` block (currently lines 55-60):

```ts
export type Decision = "allow" | "deny" | "ask";
export interface PolicyContext { readonly sessionId: string; }
export interface PermissionPolicy {
  check(call: ToolCall, ctx: PolicyContext): Decision | Promise<Decision>;
}
```

with:

```ts
export type Decision = "allow" | "deny" | "ask";
export interface PolicyContext { readonly sessionId: string; }
/** A decision plus optional provenance (which rule, why) for audit + denied messages. */
export interface PolicyVerdict { decision: Decision; ruleId?: string; reason?: string; }
// Narrower than ToolContext on purpose: a permission policy gets identity only — no emit/signal.
export interface PermissionPolicy {
  check(call: ToolCall, ctx: PolicyContext): Decision | PolicyVerdict | Promise<Decision | PolicyVerdict>;
}
```

- [ ] **Step 2: Write the failing matcher tests** — append to `packages/core/test/permission.test.ts`.

> **Import placement (applies to this and every later task):** the `import { ... } from "../src/permission"` / `import type { ... }` lines shown at the top of each task's test snippet must be **merged into the existing top-of-file import block** (the file already has `import { policy, permission } from "../src/permission";` on line 2) — do not leave `import` statements interspersed between `test(...)` calls.

```ts
import type { PermissionRule } from "../src/permission";

test("rules: content match via dot-path + operators", () => {
  const p = policy({
    default: "allow",
    rules: [
      { id: "no-rm", tool: "bash", when: { command: { contains: "rm -rf" } }, effect: "deny" },
      { id: "src-only", tool: ["write_file", "edit_file"], when: { path: { glob: "src/**" } }, effect: "allow" },
    ],
  });
  expect(p.check({ id: "1", name: "bash", input: { command: "rm -rf /" } }, { sessionId: "s" }))
    .toEqual({ decision: "deny", ruleId: "no-rm", reason: undefined });
  // bash without the pattern → no rule matches → default (bare string)
  expect(p.check({ id: "1", name: "bash", input: { command: "ls" } }, { sessionId: "s" })).toBe("allow");
  expect(p.check({ id: "1", name: "write_file", input: { path: "src/a.ts" } }, { sessionId: "s" }))
    .toMatchObject({ decision: "allow", ruleId: "src-only" });
});

test("rules: operators regex/equals/in/startsWith/not and missing/typed fields don't throw", () => {
  const p = policy({ default: "deny", rules: [
    { id: "r1", tool: "t", when: { a: { regex: "^x" } }, effect: "allow" },
    { id: "r2", tool: "t", when: { n: { in: [1, 2] } }, effect: "ask" },
    { id: "r3", tool: "t", when: { s: { not: { startsWith: "no" } } }, effect: "allow" },
  ]});
  expect(p.check({ id: "1", name: "t", input: { a: "xyz" } }, { sessionId: "s" })).toMatchObject({ decision: "allow" });
  expect(p.check({ id: "1", name: "t", input: { n: 2 } }, { sessionId: "s" })).toMatchObject({ decision: "ask" });
  expect(p.check({ id: "1", name: "t", input: { s: "ok" } }, { sessionId: "s" })).toMatchObject({ decision: "allow" });
  // missing field / non-string for a string op → no match → default
  expect(p.check({ id: "1", name: "t", input: { a: 123 } }, { sessionId: "s" })).toBe("deny");
  expect(p.check({ id: "1", name: "t", input: {} }, { sessionId: "s" })).toBe("deny");
});

test("rules: precedence deny>ask>allow across matching content rules; where predicate AND-s", () => {
  const p = policy({ rules: [
    { id: "a", tool: "bash", effect: "allow" },
    { id: "k", tool: "bash", when: { command: { contains: "sudo" } }, effect: "deny" },
    { id: "w", tool: "bash", where: (c) => (c.input as { n?: number }).n === 1, effect: "ask" },
  ]});
  expect(p.check({ id: "1", name: "bash", input: { command: "sudo x" } }, { sessionId: "s" })).toMatchObject({ decision: "deny", ruleId: "k" });
  expect(p.check({ id: "1", name: "bash", input: { command: "ls", n: 1 } }, { sessionId: "s" })).toMatchObject({ decision: "ask", ruleId: "w" });
  expect(p.check({ id: "1", name: "bash", input: { command: "ls" } }, { sessionId: "s" })).toMatchObject({ decision: "allow", ruleId: "a" });
});

test("rules: legacy arrays still return BARE strings (backward compat) even mixed with rules", () => {
  const p = policy({ deny: ["rm"], rules: [{ id: "c", tool: "bash", effect: "ask" }] });
  expect(p.check({ id: "1", name: "rm", input: {} }, { sessionId: "s" })).toBe("deny");        // legacy → bare
  expect(p.check({ id: "1", name: "bash", input: {} }, { sessionId: "s" })).toMatchObject({ decision: "ask", ruleId: "c" }); // rule → verdict
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: FAIL — `rules` not accepted, `PermissionRule` not exported.

- [ ] **Step 4: Rewrite `packages/core/src/permission/policy.ts`**

```ts
import picomatch from "picomatch";
import type { Decision, PermissionPolicy, PolicyContext, PolicyVerdict } from "../strategies";
import type { ToolCall } from "../types";

export type Condition =
  | { regex: string }
  | { glob: string }
  | { equals: unknown }
  | { in: unknown[] }
  | { startsWith: string }
  | { contains: string }
  | { not: Condition };

/** Conditions keyed by a dot-path into call.input (e.g. "command", "args.path"). AND across keys. */
export type MatchSpec = Record<string, Condition>;

export interface PermissionRule {
  id?: string;
  description?: string;
  tool?: string | string[];
  when?: MatchSpec;
  where?: (call: ToolCall, ctx: PolicyContext) => boolean;
  effect: Decision;
}

export interface PolicyOptions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  rules?: PermissionRule[];
  default?: Decision;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

const deepEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function matchCondition(value: unknown, cond: Condition): boolean {
  if ("not" in cond) return !matchCondition(value, cond.not);
  if ("equals" in cond) return deepEqual(value, cond.equals);
  if ("in" in cond) return cond.in.some((v) => deepEqual(value, v));
  if (typeof value !== "string") return false; // remaining ops require a string value
  if ("regex" in cond) return new RegExp(cond.regex).test(value);
  if ("glob" in cond) return picomatch(cond.glob, { dot: true })(value);
  if ("startsWith" in cond) return value.startsWith(cond.startsWith);
  if ("contains" in cond) return value.includes(cond.contains);
  return false;
}

function ruleMatches(rule: PermissionRule, call: ToolCall, ctx: PolicyContext): boolean {
  if (rule.tool != null) {
    const pats = Array.isArray(rule.tool) ? rule.tool : [rule.tool];
    if (!pats.some((p) => picomatch(p, { dot: true })(call.name))) return false;
  }
  if (rule.when && !Object.entries(rule.when).every(([path, c]) => matchCondition(getPath(call.input, path), c))) return false;
  if (rule.where && !rule.where(call, ctx)) return false;
  return true;
}

export function policy(opts: PolicyOptions = {}): PermissionPolicy {
  const fallback: Decision = opts.default ?? "allow";
  // Legacy name arrays desugar into rules WITHOUT ids (→ bare-string verdicts, backward compat).
  const legacy: PermissionRule[] = [
    ...(opts.deny ?? []).map((t): PermissionRule => ({ tool: t, effect: "deny" })),
    ...(opts.ask ?? []).map((t): PermissionRule => ({ tool: t, effect: "ask" })),
    ...(opts.allow ?? []).map((t): PermissionRule => ({ tool: t, effect: "allow" })),
  ];
  // Explicit content rules get an auto id ("rule-<n>") if omitted (→ always a provenance verdict).
  const content = (opts.rules ?? []).map((r, i): PermissionRule => ({ ...r, id: r.id ?? `rule-${i}` }));
  const rules = [...legacy, ...content];
  const group = (e: Decision) => rules.filter((r) => r.effect === e);
  const denyR = group("deny"), askR = group("ask"), allowR = group("allow");

  // Bare Decision for a rule with no provenance (legacy); a PolicyVerdict otherwise.
  const verdict = (decision: Decision, r: PermissionRule): Decision | PolicyVerdict =>
    r.id === undefined && r.description === undefined ? decision : { decision, ruleId: r.id, reason: r.description };

  return {
    check(call, ctx): Decision | PolicyVerdict {
      const d = denyR.find((r) => ruleMatches(r, call, ctx));
      if (d) return verdict("deny", d);
      const a = askR.find((r) => ruleMatches(r, call, ctx));
      if (a) return verdict("ask", a);
      const al = allowR.find((r) => ruleMatches(r, call, ctx));
      if (al) return verdict("allow", al);
      return fallback;
    },
  };
}
```

- [ ] **Step 5: Update exports.** In `packages/core/src/permission/index.ts` change the policy line to also export the new types:

```ts
export { policy } from "./policy";
export type { PolicyOptions, PermissionRule, MatchSpec, Condition } from "./policy";
export { permission } from "./gate";
```

In `packages/core/src/index.ts`, the existing `export type { PolicyOptions } from "./permission";` (line ~31) becomes:

```ts
export type { PolicyOptions, PermissionRule, MatchSpec, Condition } from "./permission";
```

and add `PolicyVerdict` to the strategies type re-export block (the `export type { ModelProvider, ToolCallCodec, ... Decision, ... }` list ~lines 32-37): add `PolicyVerdict`.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/core test -- permission && pnpm --filter @lite-agent/core typecheck`
Expected: PASS — new matcher tests green AND all original policy tests still green (legacy → bare strings).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/permission packages/core/src/strategies.ts packages/core/src/index.ts packages/core/test/permission.test.ts
git commit -m "feat(core): declarative content-level permission rules with provenance verdicts"
```

---

## Task 3: `permission_decision` event + gate provenance + always-emit

**Files:**
- Modify: `packages/core/src/events.ts` (add event)
- Modify: `packages/core/src/permission/gate.ts` (normalize verdict, emit, provenance message)
- Test: `packages/core/test/permission.test.ts` (update 3 exact-array gate tests + add new)

- [ ] **Step 1: Add the event to `packages/core/src/events.ts`**

After the `approval_resolved` line (line 45), add:

```ts
  | { type: "permission_decision"; call: ToolCall; decision: "allow" | "deny" | "ask"; ruleId?: string; reason?: string; simulated?: boolean; by: "policy" | "user" | "auto" }
```

- [ ] **Step 2: Update the 3 existing gate tests + add new ones** in `packages/core/test/permission.test.ts`.

The gate now emits a `permission_decision` on every decision. Update these three existing assertions:

Replace the `"permission: allow runs the tool"` test's `expect(events).toEqual([]);` (line 57) with:

```ts
  expect(events).toEqual([
    { type: "permission_decision", call: { id: "t1", name: "read_file", input: {} }, decision: "allow", ruleId: undefined, reason: undefined, by: "policy" },
  ]);
```

In `"permission: ask + approver allow emits request/resolved then runs"`, replace the `expect(events).toEqual([...])` array (lines 78-81) with:

```ts
  expect(events).toEqual([
    { type: "approval_request", call: { id: "t1", name: "bash", input: {} } },
    { type: "approval_resolved", id: "t1", decision: "allow", by: "user" },
    { type: "permission_decision", call: { id: "t1", name: "bash", input: {} }, decision: "allow", ruleId: undefined, reason: undefined, by: "user" },
  ]);
```

In `"permission: ask with no approver fails closed (by auto)"`, replace the last-event assertion (line 101) with:

```ts
  expect(events.at(-1)).toEqual({ type: "permission_decision", call: { id: "t1", name: "bash", input: {} }, decision: "deny", ruleId: undefined, reason: undefined, by: "auto" });
```

Then append a provenance test:

```ts
test("permission: a content deny rule surfaces reason in the message + a permission_decision event", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("bash", (e) => events.push(e));
  ctx.call.input = { command: "rm -rf /" };
  const pol = policy({ rules: [{ id: "no-rm", description: "destructive", tool: "bash", when: { command: { contains: "rm -rf" } }, effect: "deny" }] });
  let ran = false;
  const r = await composeToolCall([permission(pol)], ctx, async () => { ran = true; return { id: "t1", name: "bash", content: "x" }; })();
  expect(ran).toBe(false);
  expect(r).toMatchObject({ content: "Error: blocked by policy: destructive", isError: true });
  expect(events.at(-1)).toMatchObject({ type: "permission_decision", decision: "deny", ruleId: "no-rm", reason: "destructive", by: "policy" });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: FAIL — no `permission_decision` emitted; message has no reason.

- [ ] **Step 4: Rewrite `packages/core/src/permission/gate.ts`**

```ts
import type { PermissionPolicy, ApprovalHandler, Decision, PolicyVerdict } from "../strategies";
import type { Middleware, ToolCallContext } from "../middleware";
import type { AgentEvent } from "../events";
import type { ToolCall, ToolResult } from "../types";

const norm = (v: Decision | PolicyVerdict): PolicyVerdict => (typeof v === "string" ? { decision: v } : v);

function denied(ctx: ToolCallContext, base: string, reason?: string): ToolResult {
  return { id: ctx.call.id, name: ctx.call.name, content: `Error: ${base}${reason ? `: ${reason}` : ""}`, isError: true };
}

function decisionEvent(
  call: ToolCall, decision: Decision, by: "policy" | "user" | "auto", v?: PolicyVerdict,
): Extract<AgentEvent, { type: "permission_decision" }> {
  return { type: "permission_decision", call, decision, ruleId: v?.ruleId, reason: v?.reason, by };
}

export function permission(pol: PermissionPolicy, approval?: ApprovalHandler): Middleware {
  let lock: Promise<unknown> = Promise.resolve();
  const requestSerial = (call: ToolCall): Promise<"allow" | "deny"> => {
    const run = lock.then(() => approval!.request(call));
    lock = run.then(() => undefined, () => undefined);
    return run;
  };
  return {
    name: "permission",
    async wrapToolCall(ctx, next) {
      const v = norm(await pol.check(ctx.call, { sessionId: ctx.sessionId }));
      if (v.decision === "allow") {
        ctx.emit(decisionEvent(ctx.call, "allow", "policy", v));
        return next();
      }
      if (v.decision === "deny") {
        ctx.emit(decisionEvent(ctx.call, "deny", "policy", v));
        return denied(ctx, "blocked by policy", v.reason);
      }
      // ask: keep approval_request/approval_resolved for UI compatibility, then a permission_decision.
      ctx.emit({ type: "approval_request", call: ctx.call });
      const resolved = approval ? await requestSerial(ctx.call) : "deny";
      const by = approval ? "user" : "auto";
      ctx.emit({ type: "approval_resolved", id: ctx.call.id, decision: resolved, by });
      ctx.emit(decisionEvent(ctx.call, resolved, by, v));
      return resolved === "allow" ? next() : denied(ctx, "denied by user");
    },
  };
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/core test -- permission && pnpm --filter @lite-agent/core typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/events.ts packages/core/src/permission/gate.ts packages/core/test/permission.test.ts
git commit -m "feat(core): emit permission_decision with provenance on every gate decision"
```

---

## Task 4: Secret/PII redaction of the audit payload

**Files:**
- Create: `packages/core/src/permission/redact.ts`
- Modify: `packages/core/src/permission/gate.ts` (apply redactor to the event's `call`), `packages/core/src/permission/index.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/permission.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
import { defaultRedactor } from "../src/permission";

test("redaction: secrets masked in the permission_decision event; tool gets real input", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("bash", (e) => events.push(e));
  ctx.call.input = { command: "curl -H 'authorization: Bearer sk-ABCDEF1234567890abcdef' x" };
  let seen = "";
  await composeToolCall([permission(policy({ allow: ["bash"] }))], ctx, async () => {
    seen = (ctx.call.input as { command: string }).command; // tool still sees the REAL input
    return { id: "t1", name: "bash", content: "ok" };
  })();
  const ev = events.find((e) => e.type === "permission_decision") as Extract<AgentEvent, { type: "permission_decision" }>;
  const redactedCmd = (ev.call.input as { command: string }).command;
  expect(redactedCmd).toContain("[redacted]");
  expect(redactedCmd).not.toContain("sk-ABCDEF1234567890abcdef");
  expect(seen).toContain("sk-ABCDEF1234567890abcdef"); // real input reached the tool
});

test("defaultRedactor masks bearer/sk/emails and leaves plain text alone", () => {
  expect(defaultRedactor({ a: "Bearer sk-ABCDEF1234567890abcdef", b: "hi@x.com", c: "plain" })).toEqual({
    a: "[redacted]", b: "[redacted]", c: "plain",
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: FAIL — `defaultRedactor` not exported; event carries the real secret.

- [ ] **Step 3: Create `packages/core/src/permission/redact.ts`**

```ts
export type Redactor = (input: unknown) => unknown;

// Best-effort masking of common secrets/PII in string values. Matches substrings so a
// token embedded in a larger command is still masked. Documented as best-effort.
const SECRET = /(bearer\s+[\w.\-]+|sk-[\w-]{16,}|eyJ[\w.\-]{20,}|[\w.+-]{1,64}@[\w-]+\.[\w.-]+|(?:api[_-]?key|token|secret|password)["'\s:=]+[\w.\-]{6,})/gi;

const maskString = (s: string): string => s.replace(SECRET, "[redacted]");

export const defaultRedactor: Redactor = (input) => {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return maskString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(input);
};
```

- [ ] **Step 4: Apply the redactor in `packages/core/src/permission/gate.ts`.** Add the import and a `redact` option, and redact the event's `call.input`.

Change the imports at the top to add:

```ts
import type { Redactor } from "./redact";
import { defaultRedactor } from "./redact";
```

Change `decisionEvent` to take a redactor and redact the call input:

```ts
function decisionEvent(
  call: ToolCall, decision: Decision, by: "policy" | "user" | "auto", redact: Redactor, v?: PolicyVerdict,
): Extract<AgentEvent, { type: "permission_decision" }> {
  const safe: ToolCall = { ...call, input: redact(call.input) };
  return { type: "permission_decision", call: safe, decision, ruleId: v?.ruleId, reason: v?.reason, by };
}
```

Change the middleware signature and the three `decisionEvent(...)` call sites to pass `redact`:

```ts
export function permission(pol: PermissionPolicy, approval?: ApprovalHandler, opts: { redact?: Redactor } = {}): Middleware {
  const redact = opts.redact ?? defaultRedactor;
  // ...existing lock/requestSerial...
  return {
    name: "permission",
    async wrapToolCall(ctx, next) {
      const v = norm(await pol.check(ctx.call, { sessionId: ctx.sessionId }));
      if (v.decision === "allow") { ctx.emit(decisionEvent(ctx.call, "allow", "policy", redact, v)); return next(); }
      if (v.decision === "deny") { ctx.emit(decisionEvent(ctx.call, "deny", "policy", redact, v)); return denied(ctx, "blocked by policy", v.reason); }
      ctx.emit({ type: "approval_request", call: ctx.call });
      const resolved = approval ? await requestSerial(ctx.call) : "deny";
      const by = approval ? "user" : "auto";
      ctx.emit({ type: "approval_resolved", id: ctx.call.id, decision: resolved, by });
      ctx.emit(decisionEvent(ctx.call, resolved, by, redact, v));
      return resolved === "allow" ? next() : denied(ctx, "denied by user");
    },
  };
}
```

- [ ] **Step 5: Export the redactor.** In `packages/core/src/permission/index.ts` add:

```ts
export { defaultRedactor } from "./redact";
export type { Redactor } from "./redact";
```

In `packages/core/src/index.ts`, add to the value export from `./permission` (there is currently `export { policy, permission } from "./permission";` ~line 30 — change to `export { policy, permission, defaultRedactor } from "./permission";`) and add `Redactor` to the `./permission` type export list.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/core test -- permission && pnpm --filter @lite-agent/core typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/permission packages/core/src/index.ts packages/core/test/permission.test.ts
git commit -m "feat(core): redact secrets/PII from the permission audit payload"
```

---

## Task 5: Fail-closed enforcement + `strictPolicy` + dry-run mode

**Files:**
- Modify: `packages/core/src/permission/gate.ts` (fail-closed try/catch + `mode`)
- Modify: `packages/core/src/permission/policy.ts` (`strictPolicy`)
- Modify: `packages/core/src/permission/index.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/permission.test.ts`

- [ ] **Step 1: Write the failing tests** — append:

```ts
import { strictPolicy } from "../src/permission";

test("fail-closed: a throwing policy denies + emits a policy-error decision", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("bash", (e) => events.push(e));
  const bad = { check() { throw new Error("boom"); } };
  let ran = false;
  const r = await composeToolCall([permission(bad)], ctx, async () => { ran = true; return { id: "t1", name: "bash", content: "x" }; })();
  expect(ran).toBe(false);
  expect(r).toMatchObject({ content: "Error: blocked by policy: policy error: boom", isError: true });
  expect(events.at(-1)).toMatchObject({ type: "permission_decision", decision: "deny", reason: "policy error: boom", by: "policy" });
});

test("strictPolicy denies an unlisted tool and allows a listed one", () => {
  const p = strictPolicy({ allow: ["read_file"] });
  expect(p.check({ id: "1", name: "read_file", input: {} }, { sessionId: "s" })).toBe("allow");
  expect(p.check({ id: "1", name: "bash", input: {} }, { sessionId: "s" })).toBe("deny"); // default deny
});

test("dry-run: a would-deny still runs the tool, emitting simulated=true", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("rm", (e) => events.push(e));
  let ran = false;
  const r = await composeToolCall(
    [permission(policy({ deny: ["rm"] }), undefined, { mode: "dry-run" })], ctx,
    async () => { ran = true; return { id: "t1", name: "rm", content: "ran" }; },
  )();
  expect(ran).toBe(true);           // NOT blocked
  expect(r.content).toBe("ran");
  expect(events.at(-1)).toMatchObject({ type: "permission_decision", decision: "deny", simulated: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: FAIL — `strictPolicy` not exported; throwing policy propagates; no dry-run.

- [ ] **Step 3: Add `strictPolicy` to `packages/core/src/permission/policy.ts`** (after `policy`):

```ts
/** Deny-by-default posture: only what you list is permitted. Sugar for policy({ ..., default: "deny" }). */
export function strictPolicy(opts: Omit<PolicyOptions, "default"> = {}): PermissionPolicy {
  return policy({ ...opts, default: "deny" });
}
```

- [ ] **Step 4: Add fail-closed + dry-run to `packages/core/src/permission/gate.ts`.** Change the middleware options to include `mode`, wrap the check in try/catch, and honor dry-run.

Update the signature:

```ts
export function permission(
  pol: PermissionPolicy, approval?: ApprovalHandler,
  opts: { redact?: Redactor; mode?: "enforce" | "dry-run" } = {},
): Middleware {
  const redact = opts.redact ?? defaultRedactor;
  const dry = opts.mode === "dry-run";
  // ...existing lock/requestSerial...
```

Replace the `wrapToolCall` body with:

```ts
    async wrapToolCall(ctx, next) {
      let v: PolicyVerdict;
      try {
        v = norm(await pol.check(ctx.call, { sessionId: ctx.sessionId }));
      } catch (e) {
        v = { decision: "deny", reason: `policy error: ${(e as Error).message}` }; // fail closed
      }
      // dry-run: record the would-be decision but never block or prompt.
      if (dry) {
        ctx.emit({ ...decisionEvent(ctx.call, v.decision, "policy", redact, v), simulated: true });
        return next();
      }
      if (v.decision === "allow") { ctx.emit(decisionEvent(ctx.call, "allow", "policy", redact, v)); return next(); }
      if (v.decision === "deny") { ctx.emit(decisionEvent(ctx.call, "deny", "policy", redact, v)); return denied(ctx, "blocked by policy", v.reason); }
      ctx.emit({ type: "approval_request", call: ctx.call });
      const resolved = approval ? await requestSerial(ctx.call) : "deny";
      const by = approval ? "user" : "auto";
      ctx.emit({ type: "approval_resolved", id: ctx.call.id, decision: resolved, by });
      ctx.emit(decisionEvent(ctx.call, resolved, by, redact, v));
      return resolved === "allow" ? next() : denied(ctx, "denied by user");
    },
```

Note: the fail-closed deny message becomes `blocked by policy: policy error: <msg>` (base + reason), which the test asserts.

- [ ] **Step 5: Export `strictPolicy`.** In `packages/core/src/permission/index.ts` add `strictPolicy` to the `./policy` value export. In `packages/core/src/index.ts` add `strictPolicy` to the `export { policy, permission, defaultRedactor, ... } from "./permission";` line.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/core test -- permission && pnpm --filter @lite-agent/core typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/permission packages/core/src/index.ts packages/core/test/permission.test.ts
git commit -m "feat(core): fail-closed gate, strictPolicy, and dry-run permission mode"
```

---

## Task 6: `composePolicies` deny-wins combinator

**Files:**
- Modify: `packages/core/src/permission/policy.ts` (`composePolicies`)
- Modify: `packages/core/src/permission/index.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/permission.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
import { composePolicies } from "../src/permission";

test("composePolicies: a managed deny overrides a downstream allow (deny-wins)", async () => {
  const managed = policy({ rules: [{ id: "m-deny", tool: "bash", when: { command: { contains: "curl" } }, effect: "deny" }] });
  const user = policy({ allow: ["bash"], default: "allow" });
  const composed = composePolicies(managed, user);
  // check() is async and always returns a PolicyVerdict object → await + toMatchObject.
  // managed deny wins over the user allow, and its provenance carries through
  expect(await composed.check({ id: "1", name: "bash", input: { command: "curl evil" } }, { sessionId: "s" }))
    .toMatchObject({ decision: "deny", ruleId: "m-deny" });
  // where managed is silent, the user layer decides
  expect(await composed.check({ id: "1", name: "bash", input: { command: "ls" } }, { sessionId: "s" }))
    .toMatchObject({ decision: "allow" });
});

test("composePolicies merges deny>ask>allow>default across layers", async () => {
  const p = composePolicies(
    policy({ ask: ["bash"] }),
    policy({ allow: ["bash"], default: "allow" }),
  );
  // one layer says ask, the other allow → ask wins (deny>ask>allow)
  expect(await p.check({ id: "1", name: "bash", input: {} }, { sessionId: "s" })).toMatchObject({ decision: "ask" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: FAIL — `composePolicies` not exported.

- [ ] **Step 3: Add `composePolicies` to `packages/core/src/permission/policy.ts`** (after `strictPolicy`):

```ts
/** Merge policies with deny-wins (deny>ask>allow>default). A managed layer's deny is thus
 *  non-overridable by later layers. Provenance = the verdict of the layer that decided. */
export function composePolicies(...policies: PermissionPolicy[]): PermissionPolicy {
  const rank: Record<Decision, number> = { deny: 3, ask: 2, allow: 1 };
  const asVerdict = (v: Decision | PolicyVerdict): PolicyVerdict => (typeof v === "string" ? { decision: v } : v);
  return {
    async check(call, ctx): Promise<PolicyVerdict> {
      let winner: PolicyVerdict = { decision: "allow" };
      let seen = false;
      for (const p of policies) {
        const v = asVerdict(await p.check(call, ctx));
        if (!seen || rank[v.decision] > rank[winner.decision]) { winner = v; seen = true; }
      }
      return winner;
    },
  };
}
```

(Note: `PolicyVerdict` and `Decision` are already imported at the top of `policy.ts`.)

- [ ] **Step 4: Export `composePolicies`.** Add it to `packages/core/src/permission/index.ts`'s `./policy` value export and to the `./permission` value export in `packages/core/src/index.ts`.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/core test -- permission && pnpm --filter @lite-agent/core typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/permission packages/core/src/index.ts packages/core/test/permission.test.ts
git commit -m "feat(core): composePolicies deny-wins combinator for layered/managed policy"
```

---

## Task 7: sdk specifier sugar + thread options through `createLiteAgent`

**Files:**
- Create: `packages/sdk/src/permission/specifiers.ts`
- Modify: `packages/sdk/src/index.ts` (export), `packages/sdk/src/createLiteAgent.ts` (thread `{ redact, permissionMode }`)
- Test: `packages/sdk/test/permission-specifiers.test.ts`

- [ ] **Step 1: Rebuild core so the sdk sees the new API**

Run: `pnpm --filter @lite-agent/core build`
Expected: builds `dist/` with `PermissionRule`, `composePolicies`, etc.

- [ ] **Step 2: Write the failing tests** — create `packages/sdk/test/permission-specifiers.test.ts`:

```ts
import { expect, test } from "vitest";
import { bashCommand, filePath } from "../src/permission/specifiers";
import { policy } from "@lite-agent/core";

test("bashCommand: ':*' becomes a command prefix rule", () => {
  const p = policy({ rules: [bashCommand("npm run test:*", "allow"), bashCommand("rm -rf", "deny")] });
  expect(p.check({ id: "1", name: "bash", input: { command: "npm run test:unit" } }, { sessionId: "s" })).toMatchObject({ decision: "allow" });
  expect(p.check({ id: "1", name: "bash", input: { command: "rm -rf /" } }, { sessionId: "s" })).toMatchObject({ decision: "deny" });
  expect(p.check({ id: "1", name: "bash", input: { command: "ls" } }, { sessionId: "s" })).toBe("allow"); // default
});

test("filePath: gates the file tools by a path glob", () => {
  const p = policy({ default: "deny", rules: [filePath("src/**", "allow")] });
  expect(p.check({ id: "1", name: "write_file", input: { path: "src/a.ts" } }, { sessionId: "s" })).toMatchObject({ decision: "allow" });
  expect(p.check({ id: "1", name: "write_file", input: { path: "secrets/a" } }, { sessionId: "s" })).toBe("deny");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test -- permission-specifiers`
Expected: FAIL — `../src/permission/specifiers` does not exist.

- [ ] **Step 4: Create `packages/sdk/src/permission/specifiers.ts`**

```ts
import type { PermissionRule, Decision } from "@lite-agent/core";

/** `bashCommand("npm run test:*", "deny")` — a trailing `:*` matches any command with that prefix;
 *  otherwise the command must contain the given text. */
export function bashCommand(spec: string, effect: Decision): PermissionRule {
  const prefix = spec.endsWith(":*");
  const value = prefix ? spec.slice(0, -2) : spec;
  return {
    description: `bash ${spec}`,
    tool: "bash",
    when: { command: prefix ? { startsWith: value } : { contains: value } },
    effect,
  };
}

/** `filePath("src/**", "allow")` — gate the file tools (read/write/edit) by a path glob. */
export function filePath(glob: string, effect: Decision): PermissionRule {
  return {
    description: `path ${glob}`,
    tool: ["read_file", "write_file", "edit_file"],
    when: { path: { glob } },
    effect,
  };
}
```

- [ ] **Step 5: Export from `packages/sdk/src/index.ts`.** Add after the tools export block:

```ts
export { bashCommand, filePath } from "./permission/specifiers";
```

- [ ] **Step 6: Thread `redact` + `mode` through `packages/sdk/src/createLiteAgent.ts`.**

Add two optional config fields to `CreateLiteAgentConfig` (near `permission`/`onApproval`, ~line 110):

```ts
  /** Redactor for the permission audit payload (default: defaultRedactor). */
  redact?: Redactor;
  /** Permission enforcement mode. "dry-run" records decisions without blocking. Default "enforce". */
  permissionMode?: "enforce" | "dry-run";
```

Add `Redactor` to the `@lite-agent/core` type import block at the top of the file.

Change the `permission(...)` wiring in the `use` middleware array (currently `...(cfg.permission ? [permission(cfg.permission, cfg.onApproval)] : [])`, ~line 291) to:

```ts
    ...(cfg.permission ? [permission(cfg.permission, cfg.onApproval, { redact: cfg.redact, mode: cfg.permissionMode })] : []),
```

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/core build && pnpm --filter @lite-agent/sdk test -- permission-specifiers && pnpm --filter @lite-agent/sdk test -- permission && pnpm --filter @lite-agent/sdk typecheck`
Expected: PASS (specifiers + existing sdk permission wiring test + typecheck).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/permission packages/sdk/src/index.ts packages/sdk/src/createLiteAgent.ts packages/sdk/test/permission-specifiers.test.ts
git commit -m "feat(sdk): permission specifier sugar (bashCommand/filePath) + redact/mode wiring"
```

---

## Final verification (after all tasks)

- [ ] **Full workspace build + test + typecheck**

Run: `pnpm -r build && pnpm -r test && pnpm -r typecheck`
Expected: all packages build (topological order), all tests pass, no type errors.

- [ ] **Confirm backward compat**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: every ORIGINAL policy/gate assertion that wasn't intentionally updated in Task 3 still passes; legacy `policy()` returns bare strings.

---

## Notes for the versioning step (do NOT do during implementation)

`@lite-agent/core` gains a real feature (content rules, provenance, audit event, redaction, fail-closed, dry-run, composePolicies); `@lite-agent/sdk` gains specifier sugar + wiring. Per 0.x convention → **minor** for both. Fully backward compatible (no behavioral change for consumers without a `permission` policy; the only visible change for existing permission users is the additive `permission_decision` event). Flag the new `permission_decision` event and the new exports in the changelog. Run `/version-and-changelog` after merge.
