import { expect, test, vi } from "vitest";
import { policy, permission } from "../src/permission";
import { composeToolCall } from "../src/middleware";
import type { AgentContext, ToolCallContext } from "../src/middleware";
import type { AgentEvent } from "../src/events";
import type { ToolResult } from "../src/types";
import type { ApprovalHandler } from "../src/strategies";

function ctxFor(name: string, emit: (e: AgentEvent) => void): ToolCallContext {
  const base: AgentContext = {
    sessionId: "s1", messages: [], turn: 1,
    signal: new AbortController().signal, emit, state: new Map(),
  };
  return { ...base, call: { id: "t1", name, input: {} } };
}

const okExec = async (): Promise<ToolResult> => ({ id: "t1", name: "x", content: "ran" });

// --- policy() ---
test("policy: exact allow / ask / deny and unmatched default", () => {
  const p = policy({ allow: ["read_file"], ask: ["bash"], deny: ["rm"] });
  expect(p.check({ id: "1", name: "read_file", input: {} }, { sessionId: "s" })).toBe("allow");
  expect(p.check({ id: "1", name: "bash", input: {} }, { sessionId: "s" })).toBe("ask");
  expect(p.check({ id: "1", name: "rm", input: {} }, { sessionId: "s" })).toBe("deny");
  expect(p.check({ id: "1", name: "todo", input: {} }, { sessionId: "s" })).toBe("allow"); // default
});

test("policy: '*' wildcard matches and default can be deny", () => {
  const p = policy({ ask: ["write_*"], default: "deny" });
  expect(p.check({ id: "1", name: "write_file", input: {} }, { sessionId: "s" })).toBe("ask");
  expect(p.check({ id: "1", name: "read_file", input: {} }, { sessionId: "s" })).toBe("deny");
});

test("policy: precedence deny > ask > allow when a name matches several", () => {
  const p = policy({ allow: ["bash"], ask: ["bash"], deny: ["bash"] });
  expect(p.check({ id: "1", name: "bash", input: {} }, { sessionId: "s" })).toBe("deny");
  const p2 = policy({ allow: ["bash"], ask: ["bash"] });
  expect(p2.check({ id: "1", name: "bash", input: {} }, { sessionId: "s" })).toBe("ask");
});

// --- permission() middleware ---
test("permission: allow runs the tool", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("read_file", (e) => events.push(e));
  const r = await composeToolCall([permission(policy({ allow: ["read_file"] }))], ctx, okExec)();
  expect(r.content).toBe("ran");
  expect(events).toEqual([]);
});

test("permission: deny short-circuits with isError, tool never runs", async () => {
  const ctx = ctxFor("rm", () => {});
  let ran = false;
  const r = await composeToolCall(
    [permission(policy({ deny: ["rm"] }))], ctx,
    async () => { ran = true; return { id: "t1", name: "rm", content: "x" }; },
  )();
  expect(ran).toBe(false);
  expect(r).toEqual({ id: "t1", name: "rm", content: "Error: blocked by policy", isError: true });
});

test("permission: ask + approver allow emits request/resolved then runs", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("bash", (e) => events.push(e));
  const approval: ApprovalHandler = { request: vi.fn(async (): Promise<"allow" | "deny"> => "allow") };
  const r = await composeToolCall([permission(policy({ ask: ["bash"] }), approval)], ctx, okExec)();
  expect(r.content).toBe("ran");
  expect(approval.request).toHaveBeenCalledTimes(1);
  expect(events).toEqual([
    { type: "approval_request", call: { id: "t1", name: "bash", input: {} } },
    { type: "approval_resolved", id: "t1", decision: "allow", by: "user" },
  ]);
});

test("permission: ask + approver deny short-circuits", async () => {
  const ctx = ctxFor("bash", () => {});
  const approval: ApprovalHandler = { request: async () => "deny" };
  let ran = false;
  const r = await composeToolCall(
    [permission(policy({ ask: ["bash"] }), approval)], ctx,
    async () => { ran = true; return { id: "t1", name: "bash", content: "x" }; },
  )();
  expect(ran).toBe(false);
  expect(r).toMatchObject({ content: "Error: denied by user", isError: true });
});

test("permission: ask with no approver fails closed (by auto)", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("bash", (e) => events.push(e));
  const r = await composeToolCall([permission(policy({ ask: ["bash"] }))], ctx, okExec)();
  expect(r).toMatchObject({ content: "Error: denied by user", isError: true });
  expect(events.at(-1)).toEqual({ type: "approval_resolved", id: "t1", decision: "deny", by: "auto" });
});

test("permission serializes concurrent approval prompts (no overlap)", async () => {
  let active = 0;
  let maxActive = 0;
  const approval: ApprovalHandler = {
    request: async (): Promise<"allow" | "deny"> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return "allow";
    },
  };
  // One shared permission middleware instance gates both concurrent calls.
  const mw = permission(policy({ ask: ["bash"] }), approval);
  const results = await Promise.all([
    composeToolCall([mw], ctxFor("bash", () => {}), okExec)(),
    composeToolCall([mw], ctxFor("bash", () => {}), okExec)(),
  ]);
  expect(maxActive).toBe(1); // prompts never overlapped
  expect(results.every((r) => r.content === "ran")).toBe(true);
});
