# Phase 3 — Permission Gate (PermissionPolicy + ApprovalHandler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-declared `PermissionPolicy` / `ApprovalHandler` strategies into a working allow/deny/ask permission gate, end-to-end (core engine → SDK config → interactive CLI approver).

**Architecture:** A `policy()` factory produces a `PermissionPolicy` (tool-name glob matching, precedence deny > ask > allow, configurable default). A `permission(policy, approval?)` middleware implements the gate in `wrapToolCall` — exactly the spec §6 pseudocode — emitting observational `approval_request`/`approval_resolved` events and awaiting the injected `ApprovalHandler`. The SDK façade (`createLiteAgent`/`query`) exposes `permission`/`onApproval` options that prepend the middleware. The CLI app provides an interactive approver coordinating with its existing raw-mode stdin.

**Tech Stack:** TypeScript (ESM, strict), vitest, zod (already deps). No new dependencies.

**Design decisions (locked):**
- `policy()` matches **tool name** only (glob `*` wildcard, full-match). Precedence **deny > ask > allow**; unmatched → `default` (defaults to `"allow"`). Input-content matching is deferred (spec open question §435).
- `permission()` closes over `(policy, approval?)`; **no `AgentContext` surgery**. On `ask` with no approver → **fail-closed deny** (`by:"auto"`).
- Events are **observational** (kernel drains queue after the tool call resolves); the `ApprovalHandler` does the blocking I/O.
- `ask_user` (InputHandler) is **out of scope** — separate follow-up slice.

---

## File Structure

- **Create** `packages/core/src/permission.ts` — `policy()` factory + `permission()` middleware (the engine; pure, no I/O).
- **Create** `packages/core/test/permission.test.ts` — unit tests for both.
- **Modify** `packages/core/src/index.ts` — export `policy`, `permission`, `PolicyOptions`.
- **Modify** `packages/sdk/src/createLiteAgent.ts` — add `permission?`/`onApproval?`, prepend middleware.
- **Modify** `packages/sdk/src/query.ts` — add `permission?`/`onApproval?` pass-through.
- **Create** `packages/sdk/test/permission.test.ts` — integration test (deny short-circuits a tool).
- **Modify** `src/main.ts` — interactive approver + render approval events.

---

## Task 1: Core permission engine — `policy()` + `permission()` middleware

**Files:**
- Create: `packages/core/src/permission.ts`
- Test: `packages/core/test/permission.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/permission.test.ts`:

```ts
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
  const approval: ApprovalHandler = { request: vi.fn(async () => "allow") };
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/core test -- permission`
Expected: FAIL — `Cannot find module '../src/permission'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/permission.ts`:

```ts
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
```

- [ ] **Step 4: Add exports to `packages/core/src/index.ts`**

After the `noopSandbox` export line, add:

```ts
export { policy, permission } from "./permission";
export type { PolicyOptions } from "./permission";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/core test -- permission && pnpm --filter @lite-agent/core typecheck`
Expected: all permission tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/permission.ts packages/core/test/permission.test.ts packages/core/src/index.ts
git commit -m "feat(core): policy() factory + permission() gate middleware"
```

---

## Task 2: SDK wiring — `permission` / `onApproval` options

**Files:**
- Modify: `packages/sdk/src/createLiteAgent.ts`
- Modify: `packages/sdk/src/query.ts`
- Test: `packages/sdk/test/permission.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/permission.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createLiteAgent } from "../src/createLiteAgent";
import { policy, defineTool, fakeProvider, textBlock } from "@lite-agent/core";
import type { AgentEvent, ApprovalHandler } from "@lite-agent/core";

function probeTool(ran: { value: boolean }) {
  return defineTool({
    name: "probe", description: "probe", schema: z.object({}),
    execute: () => { ran.value = true; return "executed"; },
  });
}

function scriptedProvider() {
  return fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "probe", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
}

async function drain(gen: AsyncGenerator<AgentEvent, unknown>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return events;
}

test("onApproval deny short-circuits the gated tool", async () => {
  const ran = { value: false };
  const agent = createLiteAgent({
    model: scriptedProvider(), workdir: process.cwd(),
    tools: [probeTool(ran)],
    permission: policy({ ask: ["probe"] }),
    onApproval: { request: vi.fn(async () => "deny") } as ApprovalHandler,
  });
  const events = await drain(agent.run("go"));
  expect(ran.value).toBe(false);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "approval_request" }),
  );
  const tr = events.find((e) => e.type === "tool_result");
  expect(tr).toMatchObject({ result: { isError: true, content: "Error: denied by user" } });
});

test("onApproval allow lets the gated tool run", async () => {
  const ran = { value: false };
  const agent = createLiteAgent({
    model: scriptedProvider(), workdir: process.cwd(),
    tools: [probeTool(ran)],
    permission: policy({ ask: ["probe"] }),
    onApproval: { request: async () => "allow" },
  });
  await drain(agent.run("go"));
  expect(ran.value).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lite-agent/sdk test -- permission`
Expected: FAIL — `createLiteAgent` does not accept `permission`/`onApproval` (TS error or tool runs anyway).

- [ ] **Step 3: Wire `createLiteAgent`**

In `packages/sdk/src/createLiteAgent.ts`:

Update the imports — add `permission` (value) and the strategy types:

```ts
import { createAgent, nativeCodec, permission } from "@lite-agent/core";
import type { Agent, ApprovalHandler, Middleware, ModelProvider, PermissionPolicy, Sandbox, Tool } from "@lite-agent/core";
```

Add to `CreateLiteAgentConfig` (after `use?`):

```ts
  permission?: PermissionPolicy;
  onApproval?: ApprovalHandler;
```

Build the middleware array so the gate is outermost, then pass it. Replace `use: cfg.use,` in the `createAgent({...})` call with `use,` and compute it just above the `return`:

```ts
  const use: Middleware[] = [
    ...(cfg.permission ? [permission(cfg.permission, cfg.onApproval)] : []),
    ...(cfg.use ?? []),
  ];

  return createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec: nativeCodec(),
    tools,
    use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    sandbox: cfg.sandbox,
  });
```

- [ ] **Step 4: Wire `query`**

In `packages/sdk/src/query.ts`:

Add the types to the type import:

```ts
import type { AgentEvent, ApprovalHandler, Message, Middleware, ModelProvider, PermissionPolicy, RunResult, Sandbox, Tool } from "@lite-agent/core";
```

Add to `QueryOptions` (after `sandbox?`):

```ts
  permission?: PermissionPolicy;
  onApproval?: ApprovalHandler;
```

Add to the `createLiteAgent({...})` call (after `sandbox: opts.sandbox,`):

```ts
    permission: opts.permission,
    onApproval: opts.onApproval,
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @lite-agent/sdk test -- permission && pnpm --filter @lite-agent/sdk typecheck`
Expected: both tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/createLiteAgent.ts packages/sdk/src/query.ts packages/sdk/test/permission.test.ts
git commit -m "feat(sdk): permission/onApproval options wire the gate into createLiteAgent + query"
```

---

## Task 3: CLI app — interactive approver + render approval events

**Files:**
- Modify: `src/main.ts`

No automated test (the CLI entry has none by convention); verified by typecheck + manual reasoning. The reviewer validates the stdin coordination logic.

- [ ] **Step 1: Add imports and a default gate**

In `src/main.ts`, extend the SDK import and add the type:

```ts
import { createLiteAgent, policy } from "@lite-agent/sdk";
import type { AgentEvent, ApprovalHandler, Message } from "@lite-agent/sdk";
```

- [ ] **Step 2: Add a module-level pending-approval slot + the approver**

Above `const agent = createLiteAgent({...})`, add:

```ts
// During a run, stdin is in raw mode with a single 'data' listener. When an
// approval is pending, that listener routes the keypress here instead of ESC-abort.
let pendingApproval: ((decision: "allow" | "deny") => void) | null = null;

const onApproval: ApprovalHandler = {
  request: (call) =>
    new Promise((resolve) => {
      process.stdout.write(
        `\n\x1b[33m[approve] ${call.name} ${JSON.stringify(call.input)}? [y/N] \x1b[0m`,
      );
      pendingApproval = resolve;
    }),
};
```

Then pass the gate into `createLiteAgent`:

```ts
const agent = createLiteAgent({
  model: anthropic(),
  modelName: process.env["MODEL_ID"],
  workdir,
  skillsDir: join(workdir, "skills"),
  permission: policy({ ask: ["bash", "write_file"] }),
  onApproval,
});
```

- [ ] **Step 3: Render the approval-resolved event**

In `render`, add a case before `default:`:

```ts
    case "approval_resolved":
      process.stdout.write(
        ev.decision === "allow"
          ? "\x1b[32m[approved]\x1b[0m\n"
          : "\x1b[31m[denied]\x1b[0m\n",
      );
      break;
```

- [ ] **Step 4: Route keypresses to a pending approval in `onKey`**

In `main()`, replace the `onKey` body so a pending approval takes priority over ESC-abort:

```ts
    const onKey = (key: Buffer) => {
      if (pendingApproval) {
        const resolve = pendingApproval;
        pendingApproval = null;
        const ch = key.toString();
        const allow = ch === "y" || ch === "Y";
        process.stdout.write("\n");
        resolve(allow ? "allow" : "deny");
        return;
      }
      if (key[0] === 0x1b && key.length === 1) {
        ac.abort();
        process.stdout.write("\n\x1b[33m[ESC] interrupted\x1b[0m\n");
      }
    };
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(app): interactive approval gate (ask bash/write_file) in the CLI"
```

---

## Final verification (after all tasks)

Run across the workspace:

```bash
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

Expected: all packages green (core gains ~7 permission tests, sdk gains 2), typecheck clean everywhere, builds emit dist.
