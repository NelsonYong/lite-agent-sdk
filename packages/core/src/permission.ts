import type { Decision, PermissionPolicy } from "./strategies";
import type { ApprovalHandler } from "./strategies";
import type { Middleware, ToolCallContext } from "./middleware";
import type { ToolResult } from "./types";

export interface PolicyOptions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  default?: Decision;
}

// Glob → RegExp: escape every regex metachar EXCEPT '*', then '*' → '.*'. Full-match.
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function policy(opts: PolicyOptions = {}): PermissionPolicy {
  const compile = (pats?: string[]) => (pats ?? []).map(globToRegExp);
  const deny = compile(opts.deny);
  const ask = compile(opts.ask);
  const allow = compile(opts.allow);
  const fallback: Decision = opts.default ?? "allow";
  const hit = (res: RegExp[], name: string) => res.some((re) => re.test(name));
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
  return {
    name: "permission",
    async wrapToolCall(ctx, next) {
      const decision = await pol.check(ctx.call, { sessionId: ctx.sessionId });
      if (decision === "allow") return next();
      if (decision === "deny") return denied(ctx, "blocked by policy");
      ctx.emit({ type: "approval_request", call: ctx.call });
      const resolved = approval ? await approval.request(ctx.call) : "deny";
      ctx.emit({ type: "approval_resolved", id: ctx.call.id, decision: resolved, by: approval ? "user" : "auto" });
      return resolved === "allow" ? next() : denied(ctx, "denied by user");
    },
  };
}
