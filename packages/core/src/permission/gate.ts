import type { PermissionPolicy, ApprovalHandler, Decision, PolicyVerdict } from "../strategies";
import type { Middleware, ToolCallContext } from "../middleware";
import type { AgentEvent } from "../events";
import type { ToolCall, ToolResult } from "../types";
import type { Redactor } from "./redact";
import { defaultRedactor } from "./redact";

const norm = (v: Decision | PolicyVerdict): PolicyVerdict => (typeof v === "string" ? { decision: v } : v);

function denied(ctx: ToolCallContext, base: string, reason?: string): ToolResult {
  return { id: ctx.call.id, name: ctx.call.name, content: `Error: ${base}${reason ? `: ${reason}` : ""}`, isError: true };
}

function decisionEvent(
  call: ToolCall, decision: Decision, by: "policy" | "user" | "auto", redact: Redactor, v?: PolicyVerdict,
): Extract<AgentEvent, { type: "permission_decision" }> {
  const safe: ToolCall = { ...call, input: redact(call.input) };
  return { type: "permission_decision", call: safe, decision, ruleId: v?.ruleId, reason: v?.reason, by };
}

// Gate middleware (spec §6): allow → run; deny → blocked; ask → emit request, await approver, emit resolved.
export function permission(
  pol: PermissionPolicy, approval?: ApprovalHandler,
  opts: { redact?: Redactor; mode?: "enforce" | "dry-run"; audit?: boolean } = {},
): Middleware {
  const redact = opts.redact ?? defaultRedactor;
  const dry = opts.mode === "dry-run";
  const audit = opts.audit === true;
  // Serialize interactive approval prompts: with concurrent in-turn tool execution,
  // multiple ask-gated calls would otherwise prompt at the same time and overlap.
  let lock: Promise<unknown> = Promise.resolve();
  const requestSerial = (call: ToolCall): Promise<"allow" | "deny"> => {
    const run = lock.then(() => approval!.request(call));
    lock = run.then(() => undefined, () => undefined); // advance the chain regardless of outcome
    return run;
  };
  const reportDecision = async (
    ctx: ToolCallContext,
    event: Extract<AgentEvent, { type: "permission_decision" }>,
  ): Promise<void> => {
    ctx.emit(event);
    if (audit && ctx.recordSessionEvent) {
      await ctx.recordSessionEvent({ ...event, turn: ctx.turn });
    }
  };
  return {
    name: "permission",
    async wrapToolCall(ctx, next) {
      let v: PolicyVerdict;
      try {
        v = norm(await pol.check(ctx.call, { sessionId: ctx.sessionId }));
      } catch (e) {
        v = { decision: "deny", reason: `policy error: ${e instanceof Error ? e.message : String(e)}` }; // fail closed (any throw shape)
      }
      // dry-run: record the would-be decision but never block or prompt.
      if (dry) {
        await reportDecision(ctx, { ...decisionEvent(ctx.call, v.decision, "policy", redact, v), simulated: true });
        return next();
      }
      if (v.decision === "allow") {
        await reportDecision(ctx, decisionEvent(ctx.call, "allow", "policy", redact, v));
        return next();
      }
      if (v.decision === "deny") {
        await reportDecision(ctx, decisionEvent(ctx.call, "deny", "policy", redact, v));
        return denied(ctx, "blocked by policy", v.reason);
      }
      // ask: keep approval_request/approval_resolved for UI compatibility, then a permission_decision.
      ctx.emit({ type: "approval_request", call: ctx.call });
      const resolved = approval ? await requestSerial(ctx.call) : "deny";
      const by = approval ? "user" : "auto";
      ctx.emit({ type: "approval_resolved", id: ctx.call.id, decision: resolved, by });
      await reportDecision(ctx, decisionEvent(ctx.call, resolved, by, redact, v));
      return resolved === "allow" ? next() : denied(ctx, "denied by user");
    },
  };
}
