import picomatch from "picomatch";
import type { Decision, PermissionPolicy } from "./strategies";
import type { ApprovalHandler } from "./strategies";
import type { Middleware, ToolCallContext } from "./middleware";
import type { ToolCall, ToolResult } from "./types";

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

function denied(ctx: ToolCallContext, reason: string): ToolResult {
  return { id: ctx.call.id, name: ctx.call.name, content: `Error: ${reason}`, isError: true };
}

// Gate middleware (spec §6): allow → run; deny → blocked; ask → emit request, await approver, emit resolved.
export function permission(pol: PermissionPolicy, approval?: ApprovalHandler): Middleware {
  // Serialize interactive approval prompts: with concurrent in-turn tool execution,
  // multiple ask-gated calls would otherwise prompt at the same time and overlap.
  let lock: Promise<unknown> = Promise.resolve();
  const requestSerial = (call: ToolCall): Promise<"allow" | "deny"> => {
    const run = lock.then(() => approval!.request(call));
    lock = run.then(() => undefined, () => undefined); // advance the chain regardless of outcome
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
