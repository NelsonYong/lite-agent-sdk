import type { PermissionPolicy, ApprovalHandler, Decision } from "../strategies";
import type { Middleware, ToolCallContext } from "../middleware";
import type { ToolCall, ToolResult } from "../types";

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
      const raw = await pol.check(ctx.call, { sessionId: ctx.sessionId });
      const decision: Decision = typeof raw === "string" ? raw : raw.decision;
      if (decision === "allow") return next();
      if (decision === "deny") return denied(ctx, "blocked by policy");
      ctx.emit({ type: "approval_request", call: ctx.call });
      const resolved = approval ? await requestSerial(ctx.call) : "deny";
      ctx.emit({ type: "approval_resolved", id: ctx.call.id, decision: resolved, by: approval ? "user" : "auto" });
      return resolved === "allow" ? next() : denied(ctx, "denied by user");
    },
  };
}
