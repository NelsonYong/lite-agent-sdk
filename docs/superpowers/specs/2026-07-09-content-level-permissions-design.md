# Content-Level Enterprise Permissions

**Status:** Design
**Date:** 2026-07-09
**Positioning:** First deliverable for the "local-first / security / self-hostable" lane — make the permission gate precise, auditable, and fail-closed enough that data-sovereign enterprises can self-host with confidence.

## 1. Motivation

Today `policy()` (`packages/core/src/permission.ts`) matches only the **tool name** by glob (`check(call)` reads `call.name`, ignores `call.input`). Enterprises need **argument-level** decisions — allow `bash` but deny `rm -rf`, allow `write_file` only under `./src`, allow a fetch tool only to allow-listed domains — plus the trust properties that let a security team sign off: an audit trail with provenance, secret redaction, a fail-closed posture, and a way to validate a policy before enforcing it.

**Guiding constraint (why this is additive):** the `PermissionPolicy` strategy interface already hands `check(call, ctx)` the full `ToolCall` including `call.input`. Content-level decisions therefore need **no interface change** — existing name-only policies keep working unchanged. What we add is (a) a richer built-in matcher, (b) decision provenance, (c) an audit event, (d) redaction, (e) fail-closed enforcement, (f) a dry-run mode, and (g) a policy-composition combinator for layered/managed policy.

**Reference (how Claude Code does it), adopted where it's stronger:**
- Rules are `Tool(specifier)` with per-tool specifier semantics (Bash=command prefix, Read/Edit=path glob, WebFetch=domain). **Precedence is deny > ask > allow**, then the mode default. We keep **deny > ask > allow** (safer for a security product than firewall-style first-match; a mis-ordered allow can't shadow a deny).
- Enterprise "managed" settings layer that users cannot override. We model this with a deny-wins **composition** combinator (a managed deny can't be loosened downstream).
- `PreToolUse` hooks / `canUseTool` = programmatic content-aware decision. We model this with the `where` predicate escape hatch (and the existing `PermissionPolicy` seam for a full external engine).
- Honest caveat we inherit: **Bash command matching is best-effort** — shell parsing (`&&`, `$(...)`, quoting) means prefix/regex matching can be bypassed. The OS sandbox remains the real containment; the permission gate is defense-in-depth, not a shell parser.

## 2. Rule model (declarative-first + predicate escape hatch)

`policy()` gains an optional `rules` array alongside today's `allow/ask/deny` name arrays (which are kept and desugar into rules, preserving current behavior).

```ts
export interface PermissionRule {
  /** Stable id for audit/provenance; auto-generated ("rule-<n>") if omitted. */
  id?: string;
  /** Human-readable intent, surfaced in audit + readable by non-technical reviewers. */
  description?: string;
  /** Tool-name glob(s) (picomatch). Omitted = matches any tool. */
  tool?: string | string[];
  /** Declarative conditions over call.input. All fields must match (AND). Omitted = matches any input. */
  when?: MatchSpec;
  /** Predicate escape hatch for logic the declarative form can't express.
   *  AND-ed with `when`. Kept rare on purpose (non-serializable → not auditable). */
  where?: (call: ToolCall, ctx: PolicyContext) => boolean;
  effect: Decision; // "allow" | "ask" | "deny"
}

/** Conditions keyed by a dot-path into call.input (e.g. "command", "args.path"). */
export type MatchSpec = Record<string, Condition>;

export type Condition =
  | { regex: string }        // string value matches this regex (anchored? no — substring, use ^$ to anchor)
  | { glob: string }         // string value matches this glob (picomatch)
  | { equals: unknown }      // deep-equals
  | { in: unknown[] }        // value ∈ set (deep-equals)
  | { startsWith: string }   // string prefix
  | { contains: string }     // string substring
  | { not: Condition };      // negation of any of the above
```

**Field addressing** is a dot-path into `call.input` (tool-agnostic): `"command"` for bash, `"path"` for a file tool, `"url"` for a fetch tool. A path that doesn't resolve, or a type-mismatched value (e.g. `regex` on a non-string), makes that field **not match** (never throws).

**Precedence (deny > ask > allow):** collect every rule that matches (`tool` glob AND `when` AND `where`). If any matched rule has `effect: "deny"` → **deny**; else if any `"ask"` → **ask**; else if any `"allow"` → **allow**; else the `default` fallback. Provenance is the **first** matched rule of the winning effect. This preserves today's deny-takes-precedence while adding content matching. (Firewall-style first-match was considered and rejected: a mis-ordered allow-before-deny would open a hole — unacceptable for a security-first product.)

**Legacy desugaring:** `deny: ["bash"]` ≡ `{ tool: "bash", effect: "deny" }`, etc. Existing `policy({allow,ask,deny,default})` behaves identically.

## 3. Decision provenance

Widen the `PermissionPolicy.check` return so a policy may report **why**:

```ts
export type PolicyVerdict = { decision: Decision; ruleId?: string; reason?: string };
// PermissionPolicy.check now returns: Decision | PolicyVerdict | Promise<Decision | PolicyVerdict>
```

A bare `Decision` string still works (backward compatible). The gate normalizes to a `PolicyVerdict`. Provenance flows into (a) the audit event and (b) the denied tool result, e.g. `Error: blocked by policy [no-rm-rf]: destructive command`.

## 4. Audit event + durable trail

A new **observational** event (events observe; they don't decide):

```ts
| { type: "permission_decision"; call: ToolCall; decision: Decision; ruleId?: string;
    reason?: string; simulated?: boolean; by: "policy" | "user" | "auto" }
```

The gate emits it on **every** decision (today only the `ask` path emits anything): `by: "policy"` for allow/deny from rules, `by: "user"` / `"auto"` for a resolved `ask`. The `call` carried in the event is **redacted** (§6).

**Durable trail (opt-in):** when a checkpointer is present and `permission(policy, approval?, { audit: true })`, the gate also appends a `SessionEvent` (`type: "permission_decision"`, redacted) so the compliance log survives reloads. Default off (no behavior change for existing users). The existing `approval_request` / `approval_resolved` events are retained for UI compatibility.

## 5. Secret / PII redaction

```ts
export type Redactor = (input: unknown) => unknown;
```

A `Redactor` is applied to `call.input` **only for the audit payload** (the `permission_decision` event + the durable trail). The tool always receives the real, unredacted input. Default `defaultRedactor` masks values matching common secret/PII patterns (API keys, bearer tokens, `sk-…`, JWTs, emails) → `"[redacted]"`, walking strings in the input object. Replaceable via `permission({ redact })`. Cheap, best-effort, documented as such.

## 6. Fail-closed

Two guarantees:
1. **Strict preset (posture):** `default: "deny"` + an explicit allowlist is the documented deny-by-default posture; a helper `strictPolicy({ allow, rules })` sets `default: "deny"` so the safe posture is one call, not a footgun to remember.
2. **Fail-closed enforcement:** if `pol.check` **throws** or returns a malformed value, the gate **denies** (not allow), emits a `permission_decision` with `reason: "policy error: <msg>"`, and returns an isError result. A broken policy can never fail open. (Today a throwing middleware already becomes an isError result via the kernel catch; we make this explicit and audited in the gate.)

## 7. Dry-run / simulation

```ts
permission(policy, approval?, { mode?: "enforce" | "dry-run" })  // default "enforce"
```

In `dry-run` the gate computes the verdict and emits `permission_decision` with `simulated: true`, **but always runs the tool** (never blocks, never prompts). Ops can point a candidate policy at real traffic, collect the `permission_decision` stream, and see exactly what *would* be denied before flipping to `enforce`. No separate harness — it reuses the audit event.

## 8. Policy composition (layered / managed)

```ts
export function composePolicies(...policies: PermissionPolicy[]): PermissionPolicy;
```

Evaluates each policy and merges with **deny-wins** (deny > ask > allow > default). Because a `deny` from any layer wins, a **managed** layer placed in the list yields non-overridable restrictions: a downstream project/user layer cannot loosen a managed `deny`. This is the core mechanism behind Claude Code's managed-settings guarantee, expressed as a small combinator. Provenance is the winning layer's own verdict (its `ruleId` / `reason`) — the combinator adds no labels of its own.

Core ships only the combinator. The **full settings-file hierarchy** (discovering a managed `managed-permissions.json` an sdk consumer can't override, project vs user files, hot-reload) is an **sdk-level follow-up** — out of scope here.

## 9. Per-tool specifier sugar (sdk)

Core stays tool-agnostic (generic dot-path). The sdk — which knows its tools' names and input shapes — ships thin builders that expand to rules, matching Claude Code's ergonomics:

```ts
// packages/sdk/src/permission/specifiers.ts
bashCommand("npm run test:*", "deny")     // → { tool: "bash", when: { command: { startsWith: "npm run test" } }, effect: "deny" }
filePath("src/**", "allow")               // → { tool: ["write_file","edit_file","read_file"], when: { path: { glob: "src/**" } }, effect: "allow" }
domain("github.com", "allow")             // → { tool: <fetch tools>, when: { url: { regex: "^https?://([^/]*\\.)?github\\.com/" } }, effect: "allow" }
```

`:*` desugars to `startsWith`. These are pure conveniences over the core rule model — a consumer can always write the raw rule. Kept small (bash / file / domain); more can be added later.

## 10. Layout

Split the 60-line `core/src/permission.ts` into a focused folder (one responsibility per file):

```
packages/core/src/permission/
  policy.ts     # policy(), rules, MatchSpec matcher, verdict normalization, composePolicies, strictPolicy
  gate.ts       # permission() middleware: enforce/dry-run, fail-closed, audit emit + durable append
  redact.ts     # Redactor type, defaultRedactor
  index.ts      # re-exports (keeps the existing "@lite-agent/core" export surface stable)
```

- `packages/core/src/events.ts` — add the `permission_decision` event to `AgentEvent`.
- `packages/core/src/strategies.ts` — add `PolicyVerdict`; widen `PermissionPolicy.check` return type.
- `packages/core/src/index.ts` — export `PermissionRule`, `MatchSpec`, `Condition`, `PolicyVerdict`, `Redactor`, `defaultRedactor`, `composePolicies`, `strictPolicy` (the existing `policy`/`permission`/`PolicyOptions` exports keep working — `permission/index.ts` re-exports them).
- sdk: `packages/sdk/src/permission/specifiers.ts` + barrel export; `createLiteAgent` already threads `permission`/`onApproval` — extend it to pass `{ audit, redact, mode }` through (all optional, default off/enforce).

Core owns the primitive; sdk owns the tool-aware sugar and wiring — honors `[[multi-agent-goes-in-sdk]]` and `[[modular-blocks-fixed-interfaces]]`.

## 11. Testing

- **Matcher:** each operator (regex/glob/equals/in/startsWith/contains/not), dot-path resolution incl. missing/type-mismatched fields (→ no match, no throw), AND across fields, `tool` glob, `where` predicate AND-ing.
- **Precedence:** deny beats ask beats allow when multiple rules match; provenance = first winning-effect rule; `default` fallback; legacy array desugaring reproduces today's behavior exactly (port existing permission tests unchanged).
- **Provenance:** verdict object flows to the denied message and the event; a bare-string policy still works.
- **Audit event:** emitted on allow, deny, and resolved-ask; `by` correct; `call.input` redacted in the event; durable `SessionEvent` appended only when `audit:true` + checkpointer present.
- **Redaction:** secret patterns masked in the audit payload; the tool receives the real input (assert via a spy tool).
- **Fail-closed:** a throwing policy → deny + audited `policy error`; `strictPolicy` denies an unlisted tool.
- **Dry-run:** verdict computed + `simulated:true` emitted, but the tool runs even on a would-deny.
- **Composition:** `composePolicies` — a managed deny overrides a downstream allow; ask/allow/default merge order; provenance carries the winning layer.
- **sdk specifiers:** `bashCommand`/`filePath`/`domain` expand to the expected rules and gate correctly through a real kernel run.
- **Backward compat:** existing `permission`/`policy` tests pass unchanged.

## 12. Scope

**In scope (v1):** §§2–10 — the generic declarative matcher, provenance, audit event + opt-in durable trail, redaction, fail-closed, dry-run, `composePolicies`, and the small sdk specifier sugar.

**Out of scope (deferred / documented only):**
- A shipped OPA/Cedar adapter — the `PermissionPolicy` seam already allows one; v1 gives docs + one example, not a package.
- The full sdk settings-file hierarchy (managed `managed-permissions.json` discovery, project/user layering, hot-reload) — a follow-up that builds on `composePolicies`.
- Capability models, signed/tamper-evident policy, per-tenant identity threading in `PolicyContext` (the `where` predicate can read `ctx.sessionId` today).
- Robust shell parsing for bash rules — explicitly best-effort; the OS sandbox is the real containment.
