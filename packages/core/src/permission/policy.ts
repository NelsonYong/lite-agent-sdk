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
  if ("not" in cond) {
    // A missing (undefined) field fails even a negated condition; only invert a present-field result.
    if (value === undefined) return false;
    return !matchCondition(value, cond.not);
  }
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
