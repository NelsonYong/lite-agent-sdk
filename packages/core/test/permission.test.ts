import { expect, test, vi } from "vitest";
import { policy, permission, strictPolicy, defaultRedactor, composePolicies } from "../src/permission";
import type { PermissionRule } from "../src/permission";
import type { PermissionPolicy } from "../src/strategies";
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

test("policy: glob is whole-string anchored (no partial matches)", () => {
  const p = policy({ ask: ["write_*"], deny: ["bash"] });
  // '*' matches a trailing run of chars...
  expect(p.check({ id: "1", name: "write_file", input: {} }, { sessionId: "s" })).toBe("ask");
  // ...but the pattern is anchored at the start: a prefix before it does NOT match.
  expect(p.check({ id: "1", name: "prewrite_file", input: {} }, { sessionId: "s" })).toBe("allow");
  // a plain (non-glob) pattern is an EXACT match, not a substring/prefix match.
  expect(p.check({ id: "1", name: "bashx", input: {} }, { sessionId: "s" })).toBe("allow");
});

// --- permission() middleware ---
test("permission: allow runs the tool", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("read_file", (e) => events.push(e));
  const r = await composeToolCall([permission(policy({ allow: ["read_file"] }))], ctx, okExec)();
  expect(r.content).toBe("ran");
  expect(events).toEqual([
    { type: "permission_decision", call: { id: "t1", name: "read_file", input: {} }, decision: "allow", ruleId: undefined, reason: undefined, by: "policy" },
  ]);
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
    { type: "permission_decision", call: { id: "t1", name: "bash", input: {} }, decision: "allow", ruleId: undefined, reason: undefined, by: "user" },
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
  expect(events.slice(-2)).toEqual([
    { type: "approval_resolved", id: "t1", decision: "deny", by: "auto" },
    { type: "permission_decision", call: { id: "t1", name: "bash", input: {} }, decision: "deny", ruleId: undefined, reason: undefined, by: "auto" },
  ]);
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

test("a rejected approval request still advances the lock for the next waiter", async () => {
  let calls = 0;
  const approval: ApprovalHandler = {
    request: async (): Promise<"allow" | "deny"> => {
      calls++;
      if (calls === 1) throw new Error("stdin closed");
      return "allow";
    },
  };
  // One shared instance: the first (rejecting) request must not wedge the second.
  const mw = permission(policy({ ask: ["bash"] }), approval);
  const [r1, r2] = await Promise.allSettled([
    composeToolCall([mw], ctxFor("bash", () => {}), okExec)(),
    composeToolCall([mw], ctxFor("bash", () => {}), okExec)(),
  ]);
  expect(r1.status).toBe("rejected"); // caller observes the real (rejected) outcome
  expect(r2.status).toBe("fulfilled"); // chain advanced past the rejection
  if (r2.status === "fulfilled") expect(r2.value.content).toBe("ran");
});

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

test("rules: dot-path digs into nested input; multiple when keys AND", () => {
  const p = policy({ default: "deny", rules: [
    { id: "nested", tool: "t", when: { "args.path": { glob: "src/**" } }, effect: "allow" },
    { id: "both", tool: "u", when: { a: { equals: 1 }, b: { contains: "x" } }, effect: "allow" },
  ]});
  expect(p.check({ id: "1", name: "t", input: { args: { path: "src/a.ts" } } }, { sessionId: "s" })).toMatchObject({ decision: "allow", ruleId: "nested" });
  expect(p.check({ id: "1", name: "t", input: { args: { path: "dist/a.js" } } }, { sessionId: "s" })).toBe("deny");
  expect(p.check({ id: "1", name: "u", input: { a: 1, b: "x1" } }, { sessionId: "s" })).toMatchObject({ decision: "allow", ruleId: "both" });
  expect(p.check({ id: "1", name: "u", input: { a: 1, b: "zzz" } }, { sessionId: "s" })).toBe("deny"); // one key fails → AND fails
});

test("rules: negated string op fails closed on type-mismatched or missing values", () => {
  const p = policy({ default: "deny", rules: [
    { id: "safe", tool: "bash", when: { command: { not: { contains: "sudo" } } }, effect: "allow" },
  ]});
  expect(p.check({ id: "1", name: "bash", input: { command: "ls" } }, { sessionId: "s" })).toMatchObject({ decision: "allow" });
  expect(p.check({ id: "1", name: "bash", input: { command: 42 } }, { sessionId: "s" })).toBe("deny");           // non-string → not evaluable
  expect(p.check({ id: "1", name: "bash", input: { command: { evil: "sudo" } } }, { sessionId: "s" })).toBe("deny"); // object → not evaluable
  expect(p.check({ id: "1", name: "bash", input: {} }, { sessionId: "s" })).toBe("deny");                        // missing → never matches
});

test("rules: equals is structural (key order irrelevant); equals undefined ≠ missing field", () => {
  const p = policy({ rules: [
    { id: "cfg", tool: "t", when: { cfg: { equals: { a: 1, b: 2 } } }, effect: "deny" },
    { id: "u", tool: "t", when: { x: { equals: undefined } }, effect: "deny" },
  ]});
  expect(p.check({ id: "1", name: "t", input: { cfg: { b: 2, a: 1 } } }, { sessionId: "s" })).toMatchObject({ decision: "deny", ruleId: "cfg" });
  expect(p.check({ id: "1", name: "t", input: {} }, { sessionId: "s" })).toBe("allow"); // missing field matches nothing, even equals:undefined
});

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

test("defaultRedactor masks modern sk- key formats and stays linear on large benign input", () => {
  expect(defaultRedactor({ a: "sk-proj-AbCdEf1234567890XyZ", b: "sk-ant-api03-AbCdEf1234567890" })).toEqual({
    a: "[redacted]", b: "[redacted]",
  });
  // 200k chars of email-local-part-like chars with no @: quadratic regex would stall for minutes here.
  const blob = "Zm9vYmFyMTIzNDU2Nzg5MA+".repeat(10000);
  expect(defaultRedactor({ big: blob })).toEqual({ big: blob });
});

test("fail-closed: a throwing policy denies + emits a policy-error decision", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("bash", (e) => events.push(e));
  const bad = { check() { throw new Error("boom"); } } as PermissionPolicy;
  let ran = false;
  const r = await composeToolCall([permission(bad)], ctx, async () => { ran = true; return { id: "t1", name: "bash", content: "x" }; })();
  expect(ran).toBe(false);
  expect(r).toMatchObject({ content: "Error: blocked by policy: policy error: boom", isError: true });
  expect(events.at(-1)).toMatchObject({ type: "permission_decision", decision: "deny", reason: "policy error: boom", by: "policy" });
});

test("fail-closed: a policy that throws a non-Error still denies (no crash in the catch)", async () => {
  const events: AgentEvent[] = [];
  const ctx = ctxFor("bash", (e) => events.push(e));
  const bad = { check() { throw null; } } as unknown as PermissionPolicy; // eslint-disable-line no-throw-literal
  let ran = false;
  const r = await composeToolCall([permission(bad)], ctx, async () => { ran = true; return { id: "t1", name: "bash", content: "x" }; })();
  expect(ran).toBe(false);
  expect(r).toMatchObject({ content: "Error: blocked by policy: policy error: null", isError: true });
  expect(events.at(-1)).toMatchObject({ type: "permission_decision", decision: "deny", by: "policy" });
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
