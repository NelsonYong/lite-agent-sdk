import picomatch from "picomatch";
import type { Decision, PermissionPolicy } from "../strategies";

export interface PolicyOptions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  default?: Decision;
}

export function policy(opts: PolicyOptions = {}): PermissionPolicy {
  // Match tool names as globs via picomatch: whole-string anchored, '*' wildcard,
  // plus brace/character-class support. dot:true keeps '*' matching every name.
  const compile = (pats?: string[]) =>
    (pats ?? []).map((p) => picomatch(p, { dot: true }));
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
