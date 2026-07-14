# `createLiteAgent` Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `createLiteAgent.ts` into a thin composition root, an explicit assembly module, and a stateful facade without changing any public API or observable behavior.

**Architecture:** Keep `createLiteAgent()` as the synchronous composition root. Move construction-time tool/prompt/runtime wiring to internal `liteAgentAssembly.ts`, and move the public contracts plus session lifecycle to `liteAgent.ts`; use plain factory functions and one small immutable runtime record, with the recursive child `Spawn` callback injected from the root to avoid an ESM cycle.

**Tech Stack:** TypeScript 6 strict ESM, Vitest 2, pnpm 10.12.4, existing `@lite-agent/core` strategies/middleware, Zod 4.

## Global Constraints

- Follow the approved spec at `docs/superpowers/specs/2026-07-14-create-lite-agent-decomposition-design.md`.
- Preserve the `createLiteAgent()` signature, synchronous construction, package-root exports, and direct type imports from `src/createLiteAgent.ts`.
- Add characterization tests against the current implementation before moving production code; these are green-baseline refactor tests, not new behavior.
- No new SDK capability, configuration option, public export, dependency, persistence format, event, error class, registry, builder, base class, service locator, or generic Battery contribution protocol.
- Preserve tool order exactly: defaults → skills → spill → tasks → Agent → background → user tools → ask_user → allow filter → deny filter → final_answer.
- Preserve checkpointer precedence exactly: explicit checkpointer → adapted legacy store → `sessions:false` → default file checkpointer.
- Preserve middleware order exactly: compaction → reactive compaction → permission → user middleware → task reminder.
- Preserve current compactor semantics: `compactor:false` disables structural compaction, but an independently configured `contextBudget` still enables token-budget compaction and the reactive overflow net.
- Preserve child-agent config spread and overrides, including explicit checkpointer pass-through, inherited legacy store behavior, and default child file checkpointer behavior.
- Keep the selected checkpointer and effective compactor single-instanced and shared between the core agent and facade.
- Keep structured-output tool registration, prompt suffix, capture state, and normal-completion consumer as one behavior-preserving bridge.
- Do not edit `packages/sdk/src/index.ts`, `packages/sdk/src/query.ts`, or `packages/local/src/index.ts`; their unchanged compilation is part of compatibility verification.
- Do not bump versions or edit changelogs; this is a behavior-preserving internal refactor.
- Build `@lite-agent/sdk` before testing or typechecking `@lite-agent/local`, because workspace dependents consume built `dist` artifacts.

## File structure

```text
packages/sdk/src/createLiteAgent.ts          # thin public composition root and compatibility type re-exports
packages/sdk/src/liteAgentAssembly.ts        # internal batteries/runtime assembly; no package-root export
packages/sdk/src/liteAgent.ts                # public contracts + internal stateful facade factory
packages/sdk/test/createLiteAgent.test.ts    # assembly order and compactor characterization
packages/sdk/test/outputSchema.test.ts       # final_answer filtering and prompt characterization
packages/sdk/test/checkpoint-wiring.test.ts  # persistence precedence characterization
packages/sdk/test/sessions.test.ts           # synchronous run/session capture characterization
packages/sdk/test/subagents.test.ts          # child inheritance/override/persistence characterization
```

---

### Task 1: Characterize top-level assembly and facade boundaries

**Files:**
- Modify: `packages/sdk/test/createLiteAgent.test.ts`
- Modify: `packages/sdk/test/outputSchema.test.ts`
- Modify: `packages/sdk/test/checkpoint-wiring.test.ts`
- Modify: `packages/sdk/test/sessions.test.ts`

**Interfaces:**
- Consumes: current public `createLiteAgent()`, `ModelProvider`, `Compactor`, `Middleware`, `Checkpointer`, and `Store` contracts.
- Produces: green characterization coverage for tool ordering/filtering, compactor composition, middleware ordering, structured-output placement, persistence precedence, and synchronous session capture.

- [ ] **Step 1: Characterize duplicate tool execution and deny filtering**

In `packages/sdk/test/createLiteAgent.test.ts`, replace the imports with:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  defaultCompactor,
  defineTool,
  fakeProvider,
  memoryStore,
  ProviderError,
  textBlock,
} from "@lite-agent/core";
import type {
  Compactor,
  Message,
  Middleware,
  ModelProvider,
  ModelRequest,
  PermissionPolicy,
} from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { resolveProjectPaths } from "../src/paths";
import { fileTaskStore } from "../src/tasks/store";
```

Then add:

```ts
test("a user tool overrides a same-named default tool", async () => {
  const seen: ModelRequest[] = [];
  const inner = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "t1", name: "read_file", input: { path: "missing" } },
        ],
      },
    },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const model: ModelProvider = {
    id: "recording",
    stream(request, signal) {
      seen.push(request);
      return inner.stream(request, signal);
    },
  };
  const override = defineTool({
    name: "read_file",
    description: "custom read override",
    schema: z.object({ path: z.string() }),
    execute: () => "custom read",
  });
  const agent = createLiteAgent({
    model,
    workdir: process.cwd(),
    tools: [override],
    sessions: false,
    tasks: false,
    agents: false,
    cleanup: false,
    compactor: false,
  });

  const results: string[] = [];
  for await (const event of agent.run("go")) {
    if (event.type === "tool_result") results.push(event.result.content);
  }

  expect(seen[0]!.tools?.filter((entry) => entry.name === "read_file")).toHaveLength(2);
  expect(results).toEqual(["custom read"]);
});

test("disallowedTools removes a registered tool", async () => {
  const model = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "t1", name: "read_file", input: { path: "missing" } },
        ],
      },
    },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({
    model,
    workdir: process.cwd(),
    disallowedTools: ["read_file"],
    sessions: false,
    tasks: false,
    agents: false,
    cleanup: false,
    compactor: false,
  });

  const results: string[] = [];
  for await (const event of agent.run("go")) {
    if (event.type === "tool_result") results.push(event.result.content);
  }

  expect(results).toEqual(["Error: unknown tool 'read_file'"]);
});
```

- [ ] **Step 2: Run the tool-assembly characterizations on the old implementation**

Run:

```bash
pnpm --filter @lite-agent/sdk exec vitest run test/createLiteAgent.test.ts
```

Expected: PASS. The request contains two `read_file` specs while the later user implementation executes, and `disallowedTools` removes the default implementation.

- [ ] **Step 3: Characterize compactor composition and `compactor:false` with a context budget**

The imports from Step 1 already include `Compactor`. Add:

```ts
test("token-budget compaction runs after structural compaction", async () => {
  const order: string[] = [];
  const structuralMessages: Message[] = [{ role: "user", content: "STRUCTURAL" }];
  const structural: Compactor = {
    async maybeCompact(messages) {
      order.push(`structural:${String(messages[0]?.content)}`);
      return { messages: structuralMessages };
    },
  };
  const agent = createLiteAgent({
    model: fakeProvider([
      { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
    ]),
    workdir: process.cwd(),
    sessions: false,
    tasks: false,
    agents: false,
    cleanup: false,
    compactor: structural,
    contextBudget: {
      maxTokens: 10,
      estimator(messages) {
        order.push(`budget:${String(messages[0]?.content)}`);
        return 1;
      },
    },
  });

  await agent.send("ORIGINAL");

  expect(order).toEqual(["structural:ORIGINAL", "budget:STRUCTURAL"]);
});

test("contextBudget remains active when structural compaction is disabled", async () => {
  let estimates = 0;
  const agent = createLiteAgent({
    model: fakeProvider([
      { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
    ]),
    workdir: process.cwd(),
    sessions: false,
    tasks: false,
    agents: false,
    cleanup: false,
    compactor: false,
    contextBudget: {
      maxTokens: 10,
      estimator() {
        estimates += 1;
        return 1;
      },
    },
  });

  await agent.send("go");

  expect(estimates).toBeGreaterThan(0);
});
```

- [ ] **Step 4: Characterize lifecycle, model-call, tool-call, and task-reminder order**

The imports from Step 1 already include `Middleware`, `PermissionPolicy`,
`resolveProjectPaths`, and `fileTaskStore`. Add:

```ts
test("assembles compaction, permission, user middleware, and task reminder in order", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "mw-order-"));
  const home = mkdtempSync(join(tmpdir(), "mw-home-"));
  const taskStore = fileTaskStore({
    dir: resolveProjectPaths({ workdir, home }).tasksDir,
    listId: "default",
  });
  await taskStore.create({ subject: "pending task", description: "d" });

  const order: string[] = [];
  const compactor: Compactor = {
    async maybeCompact(messages) {
      order.push("compaction");
      return { messages };
    },
  };
  const permissionPolicy: PermissionPolicy = {
    check() {
      order.push("permission");
      return "allow";
    },
  };
  const user: Middleware = {
    name: "user",
    beforeModel() {
      order.push("user:beforeModel");
    },
    async *wrapModelCall(ctx, next) {
      const hasReminder = ctx.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("<system-reminder>"),
      );
      order.push(`user:model:${hasReminder ? "reminder" : "plain"}`);
      yield* next();
    },
    async wrapToolCall(_ctx, next) {
      order.push("user:tool");
      return next();
    },
  };
  const probe = defineTool({
    name: "probe",
    description: "probe",
    schema: z.object({}),
    execute: () => {
      order.push("tool");
      return "ok";
    },
  });
  const inner = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "probe", input: {} }],
      },
    },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  let modelCalls = 0;
  const model: ModelProvider = {
    id: "order",
    async *stream(request, signal) {
      modelCalls += 1;
      const hasReminder = request.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("<system-reminder>"),
      );
      order.push(`provider:${hasReminder ? "reminder" : "plain"}`);
      if (modelCalls === 1) throw new ProviderError("prompt too long", 413);
      yield* inner.stream(request, signal);
    },
  };

  const agent = createLiteAgent({
    model,
    workdir,
    home,
    cleanup: false,
    sessions: false,
    spill: false,
    agents: false,
    background: false,
    compactor,
    permission: permissionPolicy,
    use: [user],
    tools: [probe],
  });

  await agent.send("go");

  expect(order).toEqual([
    "compaction",
    "user:beforeModel",
    "user:model:plain",
    "provider:reminder",
    "user:model:plain",
    "provider:reminder",
    "permission",
    "user:tool",
    "tool",
    "compaction",
    "user:beforeModel",
    "user:model:plain",
    "provider:reminder",
  ]);
});
```

This test pins the observable lifecycle and onion ordering. The first provider
overflow causes the outer reactive middleware to re-enter the user middleware,
while the provider still sees the innermost task reminder on both attempts.

- [ ] **Step 5: Run the compactor and middleware characterizations**

Run:

```bash
pnpm --filter @lite-agent/sdk exec vitest run test/createLiteAgent.test.ts
```

Expected: PASS with the current implementation and no stray output.

- [ ] **Step 6: Characterize structured-output placement and prompt composition**

In `outputSchema.test.ts`, add the type-only import:

```ts
import type { ModelProvider } from "@lite-agent/core";
```

Then add:

```ts
test("final_answer survives both allow and deny filters", async () => {
  const schema = z.object({ answer: z.string() });
  const model = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "f1", name: "final_answer", input: { answer: "ready" } },
        ],
      },
    },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({
    model,
    ...base(),
    outputSchema: schema,
    allowedTools: [],
    disallowedTools: ["final_answer"],
  });

  expect((await agent.send("go")).output).toEqual({ answer: "ready" });
});

test("outputSchema appends its suffix to a custom system prompt", async () => {
  let seenSystem: string | undefined;
  const inner = fakeProvider([
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const model: ModelProvider = {
    id: "system-recorder",
    stream(request, signal) {
      seenSystem = request.system;
      return inner.stream(request, signal);
    },
  };
  const agent = createLiteAgent({
    model,
    ...base(),
    system: "CUSTOM SYSTEM",
    outputSchema: z.object({ answer: z.string() }),
  });

  await agent.send("go");

  expect(seenSystem).toBe(
    "CUSTOM SYSTEM\n\n## Final answer\n" +
      "When you have fully completed the task, you MUST call the `final_answer` tool " +
      "exactly once with your result. Do not put the final result in a normal message — " +
      "only the `final_answer` tool call is read as the answer.",
  );
});

test("without outputSchema preserves the raw result object shape", async () => {
  const agent = createLiteAgent({
    model: fakeProvider([
      { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    ...base(),
  });

  const result = await agent.send("go");

  expect(Object.hasOwn(result, "output")).toBe(false);
});
```

- [ ] **Step 7: Characterize persistence precedence**

In `checkpoint-wiring.test.ts`, replace the core value import with:

```ts
import {
  fakeProvider,
  memoryCheckpointer,
  memoryStore,
  textBlock,
} from "@lite-agent/core";
```

Then add:

```ts
test("an explicit checkpointer overrides a legacy store and sessions:false", async () => {
  const checkpointer = memoryCheckpointer();
  const store = memoryStore();
  const agent = createLiteAgent({
    model: fakeProvider([
      { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
    ]),
    workdir: wd(),
    checkpointer,
    store,
    sessions: false,
    cleanup: false,
    compactor: false,
  });
  const id = agent.sessionId;

  await agent.send("through checkpointer");

  expect(await checkpointer.head(id)).toBe(2);
  expect(await store.load(id)).toBeNull();
  expect((await agent.listSessions()).map((session) => session.id)).toContain(id);
});

test("a legacy store overrides sessions:false", async () => {
  const store = memoryStore();
  const agent = createLiteAgent({
    model: fakeProvider([
      { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
    ]),
    workdir: wd(),
    store,
    sessions: false,
    cleanup: false,
    compactor: false,
  });
  const id = agent.sessionId;

  await agent.send("through store");

  expect(await store.load(id)).toContainEqual({
    role: "user",
    content: "through store",
  });
  await expect(agent.listSessions()).resolves.toEqual([]);
});
```

- [ ] **Step 8: Characterize synchronous run/session capture**

In `sessions.test.ts`, replace the core value import with:

```ts
import {
  fakeProvider,
  memoryCheckpointer,
  memoryStore,
  textBlock,
} from "@lite-agent/core";
```

Then add:

```ts
test("run captures the current session before its first next call", async () => {
  const checkpointer = memoryCheckpointer();
  const agent = createLiteAgent({
    model: reply("ok"),
    workdir: freshWorkdir(),
    checkpointer,
    cleanup: false,
    compactor: false,
  });
  agent.resume("captured-before-run");

  const run = agent.run("hello");
  agent.resume("selected-after-run");
  for await (const _event of run) {
    // Drain the run; the assertion is on the persisted session id.
  }

  expect(await checkpointer.head("captured-before-run")).toBe(2);
  expect(await checkpointer.head("selected-after-run")).toBe(0);
});
```

- [ ] **Step 9: Run all Task 1 characterization tests**

Run:

```bash
pnpm --filter @lite-agent/sdk exec vitest run test/createLiteAgent.test.ts test/outputSchema.test.ts test/checkpoint-wiring.test.ts test/sessions.test.ts
pnpm --filter @lite-agent/sdk typecheck
```

Expected: all selected tests pass against the unchanged implementation; typecheck succeeds.

- [ ] **Step 10: Commit Task 1**

```bash
git add packages/sdk/test/createLiteAgent.test.ts packages/sdk/test/outputSchema.test.ts packages/sdk/test/checkpoint-wiring.test.ts packages/sdk/test/sessions.test.ts
git commit -m "test(sdk): characterize lite agent assembly"
```

---

### Task 2: Characterize recursive subagent construction

**Files:**
- Modify: `packages/sdk/test/subagents.test.ts`

**Interfaces:**
- Consumes: current recursive child factory inside `createLiteAgent()`, `Agent` tool forwarding, injected checkpointer/store seams, and public config inheritance.
- Produces: characterization coverage required before the child `Spawn` closure is hoisted and injected into assembly.

- [ ] **Step 1: Characterize child definition overrides and stripped parent-only facilities**

Replace the imports with:

```ts
import { expect, test, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  defineTool,
  fakeProvider,
  memoryCheckpointer,
  memoryStore,
  policy,
  textBlock,
} from "@lite-agent/core";
import type {
  AgentEvent,
  ModelProvider,
  ModelRequest,
} from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { resolveProjectPaths } from "../src/paths";
import { fileTaskStore } from "../src/tasks/store";
```

Then add:

```ts
test("a child applies definition overrides and strips parent-only facilities", async () => {
  const wd = workdir();
  const dir = mkdtempSync(join(tmpdir(), "subagent-def-"));
  writeFileSync(
    join(dir, "worker.md"),
    "---\nname: worker\ndescription: worker agent\n" +
      "tools: probe, Agent, ask_user\nmodel: child-model\n---\nCHILD BODY",
  );

  let ran = false;
  const probe = defineTool({
    name: "probe",
    description: "probe",
    schema: z.object({}),
    execute: () => {
      ran = true;
      return "probe ran";
    },
  });
  const requests: ModelRequest[] = [];
  const inner = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [{
          type: "tool_call",
          id: "p1",
          name: "Agent",
          input: {
            tasks: [{
              subagent_type: "worker",
              prompt: "child prompt",
              resume: "agent-worker-overrides",
            }],
            run_in_background: false,
          },
        }],
      },
    },
    {
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "probe", input: {} }],
      },
    },
    { text: "child done", message: { role: "assistant", content: [textBlock("child done")] } },
    { text: "parent done", message: { role: "assistant", content: [textBlock("parent done")] } },
  ]);
  const model: ModelProvider = {
    id: "recorder",
    stream(request, signal) {
      requests.push(request);
      return inner.stream(request, signal);
    },
  };
  const agent = createLiteAgent({
    model,
    modelName: "parent-model",
    workdir: wd,
    agentsDir: dir,
    tools: [probe],
    allowedTools: ["Agent"],
    onAskUser: { request: async () => ({ text: "parent answer" }) },
    outputSchema: z.object({ answer: z.string() }),
    temperature: 0.25,
    topP: 0.75,
    toolChoice: "auto",
    seed: 17,
    maxTokens: 128,
    tasks: false,
    spill: false,
    background: false,
    sessions: false,
    cleanup: false,
    compactor: false,
  });

  await collectResults(agent.run("start"));

  const childRequest = requests[1]!;
  expect(ran).toBe(true);
  expect(childRequest.model).toBe("child-model");
  expect(childRequest.temperature).toBe(0.25);
  expect(childRequest.topP).toBe(0.75);
  expect(childRequest.toolChoice).toBe("auto");
  expect(childRequest.seed).toBe(17);
  expect(childRequest.maxTokens).toBe(128);
  expect(childRequest.system).toBe(
    `You are the "worker" subagent operating in ${wd}. ` +
      "Return your final answer as your last message.\n\nCHILD BODY",
  );
  expect(childRequest.tools?.map((entry) => entry.name)).toEqual(["probe"]);
  expect(childRequest.system).not.toContain("## Final answer");
});
```

The definition deliberately allows `Agent` and `ask_user`: only `probe` remains because child recursion and interactivity are disabled. The absence of `final_answer` and its prompt suffix proves the parent output schema is stripped.

- [ ] **Step 2: Characterize child permission isolation**

Add:

```ts
test("subagentPermission gates child tools without sharing the parent approval handler", async () => {
  let ran = false;
  const approval = vi.fn(async (): Promise<"allow" | "deny"> => "allow");
  const probe = defineTool({
    name: "probe",
    description: "probe",
    schema: z.object({}),
    execute: () => {
      ran = true;
      return "probe ran";
    },
  });
  const model = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [{
          type: "tool_call",
          id: "p1",
          name: "Agent",
          input: {
            tasks: [{
              subagent_type: "worker",
              prompt: "child prompt",
              resume: "agent-worker-permission",
            }],
            run_in_background: false,
          },
        }],
      },
    },
    {
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "probe", input: {} }],
      },
    },
    { text: "child done", message: { role: "assistant", content: [textBlock("child done")] } },
    { text: "parent done", message: { role: "assistant", content: [textBlock("parent done")] } },
  ]);
  const agent = createLiteAgent({
    model,
    workdir: workdir(),
    agentsDir: agentsDir("worker"),
    tools: [probe],
    subagentPermission: policy({ ask: ["probe"] }),
    onApproval: { request: approval },
    sessions: false,
    tasks: false,
    spill: false,
    background: false,
    cleanup: false,
    compactor: false,
  });
  const events: AgentEvent[] = [];
  for await (const event of agent.run("start")) events.push(event);

  expect(ran).toBe(false);
  expect(approval).not.toHaveBeenCalled();
  expect(events).toContainEqual(
    expect.objectContaining({
      agentId: "agent-worker-permission",
      type: "tool_result",
      result: expect.objectContaining({
        name: "probe",
        isError: true,
        content: "Error: denied by user",
      }),
    }),
  );
});
```

- [ ] **Step 3: Characterize child persistence inheritance**

Add:

```ts
test("subagents inherit explicit checkpointers and legacy stores", async () => {
  const checkpointer = memoryCheckpointer();
  const withCheckpointer = createLiteAgent({
    model: fakeProvider([
      {
        message: {
          role: "assistant",
          content: [{
            type: "tool_call",
            id: "p1",
            name: "Agent",
            input: {
              tasks: [{
                subagent_type: "worker",
                prompt: "cp prompt",
                resume: "agent-worker-cp",
              }],
            },
          }],
        },
      },
      { text: "child done", message: { role: "assistant", content: [textBlock("child done")] } },
      { text: "parent done", message: { role: "assistant", content: [textBlock("parent done")] } },
    ]),
    workdir: workdir(),
    agentsDir: agentsDir("worker"),
    checkpointer,
    sessions: false,
    cleanup: false,
    compactor: false,
  });
  await collectResults(withCheckpointer.run("start"));
  expect(await checkpointer.head("agent-worker-cp")).toBeGreaterThan(0);

  const store = memoryStore();
  const withStore = createLiteAgent({
    model: fakeProvider([
      {
        message: {
          role: "assistant",
          content: [{
            type: "tool_call",
            id: "p2",
            name: "Agent",
            input: {
              tasks: [{
                subagent_type: "worker",
                prompt: "store prompt",
                resume: "agent-worker-store",
              }],
            },
          }],
        },
      },
      { text: "child done", message: { role: "assistant", content: [textBlock("child done")] } },
      { text: "parent done", message: { role: "assistant", content: [textBlock("parent done")] } },
    ]),
    workdir: workdir(),
    agentsDir: agentsDir("worker"),
    store,
    sessions: false,
    cleanup: false,
    compactor: false,
  });
  await collectResults(withStore.run("start"));
  expect(await store.load("agent-worker-store")).toContainEqual({
    role: "user",
    content: "store prompt",
  });
});
```

The existing durable-transcript test continues to cover the absent-checkpointer/absent-store branch, where a child builds its default file checkpointer.

- [ ] **Step 4: Run subagent characterization and typecheck**

Run:

```bash
pnpm --filter @lite-agent/sdk exec vitest run test/subagents.test.ts
pnpm --filter @lite-agent/sdk typecheck
```

Expected: all subagent tests pass against the unchanged implementation; typecheck succeeds.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/sdk/test/subagents.test.ts
git commit -m "test(sdk): characterize subagent assembly"
```

---

### Task 3: Extract public contracts and the stateful facade

**Files:**
- Create: `packages/sdk/src/liteAgent.ts`
- Modify: `packages/sdk/src/createLiteAgent.ts:1-173,373-485`

**Interfaces:**
- Consumes: the existing public `CreateLiteAgentConfig`, `LiteAgentResult`, and `LiteAgent` declarations; the existing core `Agent`; selected `Checkpointer`; effective `Compactor`; structured-output capture map; safe file helpers.
- Produces: `LiteAgentRuntime` and `createLiteAgentFacade(runtime, workdir)`, while `createLiteAgent.ts` continues to re-export only the original three public contracts.

- [ ] **Step 1: Establish the facade-focused green baseline**

Run:

```bash
pnpm --filter @lite-agent/sdk exec vitest run test/sessions.test.ts test/checkpoint-wiring.test.ts test/restore.test.ts test/compact.test.ts test/time-travel-integration.test.ts test/outputSchema.test.ts
```

Expected: PASS before moving code.

- [ ] **Step 2: Create `liteAgent.ts` with unchanged public contracts and the runtime contract**

Move `CreateLiteAgentConfig`, `LiteAgentResult`, and `LiteAgent` from `createLiteAgent.ts` without changing any property, comment, optionality, or type. Add the exact value/type imports those declarations require, then add this internal contract:

```ts
/** Internal construction result. Not re-exported from createLiteAgent.ts or index.ts. */
export interface LiteAgentRuntime {
  readonly core: Agent;
  readonly checkpointer?: Checkpointer;
  /** The effective composed compactor shared with manual compact(). */
  readonly compactor?: Compactor;
  /** Present only with outputSchema; returns and removes one session's capture. */
  readonly takeOutput?: (sessionId: string) => unknown;
}
```

Use these runtime imports in the new file:

```ts
import { AgentError, estimateTokens, foldEvents } from "@lite-agent/core";
import type {
  Agent,
  AgentEvent,
  ApprovalHandler,
  BackgroundLimits,
  Checkpointer,
  Compactor,
  InputHandler,
  Message,
  Middleware,
  ModelProvider,
  PermissionPolicy,
  Redactor,
  RunOptions,
  RunResult,
  Sandbox,
  Store,
  Tool,
  ToolCallCodec,
  ToolChoice,
  TokenEstimator,
} from "@lite-agent/core";
import type { ZodType } from "zod";
import { existsSync, unlinkSync } from "node:fs";
import { atomicWriteFile, resolveSafePath } from "./tools/file";
import type { FileToolsOptions } from "./tools/file";
import type { BashToolOptions } from "./tools/bash";
import { newSessionId } from "./store";
import type { SessionInfo } from "./store";
```

- [ ] **Step 3: Implement the stateful facade by moving the existing logic unchanged**

Below the contracts in `liteAgent.ts`, add:

```ts
export function createLiteAgentFacade(
  runtime: LiteAgentRuntime,
  workdir: string,
): LiteAgent {
  let currentSessionId = newSessionId();
  const noSessions = (): Promise<never> =>
    Promise.reject(
      new AgentError("session management requires a checkpointer (it is disabled when sessions:false)"),
    );

  const run = (
    input: string | Message[],
    opts?: RunOptions,
  ): AsyncGenerator<AgentEvent, LiteAgentResult> => {
    const sessionId = opts?.sessionId ?? currentSessionId;
    const gen = runtime.core.run(input, { ...opts, sessionId });
    const takeOutput = runtime.takeOutput;
    if (!takeOutput) return gen;
    return (async function* () {
      let result = await gen.next();
      while (!result.done) {
        yield result.value;
        result = await gen.next();
      }
      return { ...result.value, output: takeOutput(sessionId) };
    })();
  };

  return {
    run,
    async send(input, opts) {
      const gen = run(input, opts);
      let result = await gen.next();
      while (!result.done) result = await gen.next();
      return result.value;
    },
    get sessionId() {
      return currentSessionId;
    },
    resume(id: string) {
      currentSessionId = id;
    },
    clear() {
      currentSessionId = newSessionId();
      return currentSessionId;
    },
    deleteSession: (id: string) =>
      runtime.checkpointer ? runtime.checkpointer.delete(id) : noSessions(),
    listSessions: () =>
      runtime.checkpointer ? runtime.checkpointer.list() : noSessions(),
    listCheckpoints: async (id: string) => {
      if (!runtime.checkpointer) return noSessions();
      const checkpoints: { seq: number; prompt: string; ts: string }[] = [];
      for await (const entry of runtime.checkpointer.read(id)) {
        if (entry.event.type === "user" && typeof entry.event.message.content === "string") {
          checkpoints.push({
            seq: entry.seq - 1,
            prompt: entry.event.message.content,
            ts: entry.ts,
          });
        }
      }
      return checkpoints;
    },
    restore: async (
      id: string,
      toSeq: number,
      opts?: { conversation?: boolean; files?: boolean },
    ) => {
      if (!runtime.checkpointer) return noSessions();
      const files = opts?.files ?? true;
      const conversation = opts?.conversation ?? true;
      if (files) {
        const earliest = new Map<
          string,
          {
            before: string | null;
            truncated?: boolean;
            encoding?: "utf8" | "base64";
          }
        >();
        for await (const entry of runtime.checkpointer.read(id, { sinceSeq: toSeq })) {
          if (entry.event.type === "file_snapshot" && !earliest.has(entry.event.path)) {
            earliest.set(entry.event.path, {
              before: entry.event.before,
              truncated: entry.event.truncated,
              encoding: entry.event.encoding,
            });
          }
        }
        for (const [path, snapshot] of earliest) {
          if (snapshot.truncated) continue;
          const file = resolveSafePath(workdir, path, {
            mode: snapshot.before === null ? "delete" : "write",
            symlinks: "deny",
          });
          if (snapshot.before === null) {
            if (existsSync(file)) unlinkSync(file);
          } else {
            const body = snapshot.encoding === "base64"
              ? Buffer.from(snapshot.before, "base64")
              : snapshot.before;
            atomicWriteFile(file, body);
          }
        }
      }
      if (conversation) {
        if (!runtime.checkpointer.truncate) {
          throw new AgentError("conversation restore requires a checkpointer that supports truncate");
        }
        await runtime.checkpointer.truncate(id, toSeq);
      }
      currentSessionId = id;
    },
    async *compact(instructions) {
      if (!runtime.checkpointer) {
        await noSessions();
        return { before: 0, after: 0 };
      }
      if (!runtime.compactor) {
        throw new AgentError("compact requires a compactor (it is disabled when compactor:false)");
      }
      const id = currentSessionId;
      const stored = [];
      for await (const entry of runtime.checkpointer.read(id)) stored.push(entry);
      const messages = foldEvents(stored.map((entry) => entry.event));
      const before = estimateTokens(messages);
      yield { type: "compaction", kind: "manual", phase: "start", before, after: before };
      const result = await runtime.compactor.maybeCompact(
        messages,
        { inputTokens: 0, outputTokens: 0 },
        instructions,
      );
      const after = estimateTokens(result.messages);
      if (result.messages !== messages) {
        const head = stored.length ? stored[stored.length - 1]!.seq : 0;
        await runtime.checkpointer.append(
          id,
          [{ type: "summary", messages: result.messages, throughSeq: head, before, after }],
          head,
        );
      }
      yield { type: "compaction", kind: "manual", phase: "done", before, after };
      return { before, after };
    },
  };
}
```

Do not convert `run` itself into an `async function*`; doing so defers session selection until `.next()` and breaks the Task 1 characterization.

- [ ] **Step 4: Convert `createLiteAgent.ts` to use the facade without moving assembly yet**

At the top, import the facade and contracts, and re-export only the original public types:

```ts
import { createLiteAgentFacade } from "./liteAgent";
import type { CreateLiteAgentConfig, LiteAgent } from "./liteAgent";

export type {
  CreateLiteAgentConfig,
  LiteAgent,
  LiteAgentResult,
} from "./liteAgent";
```

Remove the original three declarations from `createLiteAgent.ts`. Replace the original session/facade block after `createAgent(...)` with:

```ts
  const takeOutput = cfg.outputSchema
    ? (sessionId: string): unknown => {
        const output = outputs.get(sessionId);
        outputs.delete(sessionId);
        return output;
      }
    : undefined;

  return createLiteAgentFacade(
    { core, checkpointer, compactor, takeOutput },
    cfg.workdir,
  );
```

Remove imports that moved exclusively to `liteAgent.ts`; keep all assembly imports for Task 4.

- [ ] **Step 5: Verify the extracted facade and compatibility types**

Run:

```bash
pnpm --filter @lite-agent/sdk exec vitest run test/sessions.test.ts test/checkpoint-wiring.test.ts test/restore.test.ts test/compact.test.ts test/time-travel-integration.test.ts test/outputSchema.test.ts
pnpm --filter @lite-agent/sdk typecheck
pnpm --filter @lite-agent/sdk build
pnpm --filter @lite-agent/local typecheck
```

Expected: all focused tests pass; SDK typecheck/build succeeds; unchanged local source compiles against the rebuilt SDK declarations.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/sdk/src/createLiteAgent.ts packages/sdk/src/liteAgent.ts
git commit -m "refactor(sdk): extract lite agent facade"
```

---

### Task 4: Extract batteries/runtime assembly and reduce the composition root

**Files:**
- Create: `packages/sdk/src/liteAgentAssembly.ts`
- Modify: `packages/sdk/src/createLiteAgent.ts`

**Interfaces:**
- Consumes: `CreateLiteAgentConfig`, `LiteAgentRuntime`, `ProjectPaths`, and the injected existing `Spawn` callback.
- Produces: `assembleLiteAgent({ cfg, paths, spawn }): LiteAgentRuntime`; `createLiteAgent.ts` becomes path resolution + cleanup + recursive spawn + assembly + facade.

- [ ] **Step 1: Establish the complete SDK green baseline**

Run:

```bash
pnpm --filter @lite-agent/sdk test
pnpm --filter @lite-agent/sdk typecheck
```

Expected: the complete SDK suite and typecheck pass after Task 3.

- [ ] **Step 2: Create `liteAgentAssembly.ts` with the existing ordered assembly**

Create the file with these imports and contract:

```ts
import {
  compaction,
  createAgent,
  defaultCompactor,
  legacyStoreAdapter,
  nativeCodec,
  permission,
  reactiveCompaction,
  tokenBudgetCompactor,
} from "@lite-agent/core";
import type { Checkpointer, Compactor, Middleware, Tool } from "@lite-agent/core";
import { tool } from "./tool";
import { askUserTool, defaultTools } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";
import { fileCheckpointer } from "./checkpoint";
import { fileSpillStore, readSpilledTool } from "./spill";
import { fileTaskStore } from "./tasks/store";
import { taskTools } from "./tools/task";
import { taskReminder } from "./tasks/reminder";
import { AgentLoader } from "./agents/loader";
import { builtinAgents } from "./agents/builtin";
import { agentTool } from "./tools/agent";
import type { Spawn } from "./tools/agent";
import { killBackgroundTool } from "./tools/killBackground";
import { bashOutputTool } from "./tools/bashOutput";
import type { ProjectPaths } from "./paths";
import type { CreateLiteAgentConfig, LiteAgentRuntime } from "./liteAgent";

interface AssembleLiteAgentOptions {
  readonly cfg: CreateLiteAgentConfig;
  readonly paths: ProjectPaths;
  readonly spawn: Spawn;
}

export function assembleLiteAgent({
  cfg,
  paths,
  spawn,
}: AssembleLiteAgentOptions): LiteAgentRuntime {
```

Inside the function, move the current assembly statements in their existing order. The complete body is:

```ts
  let tools: Tool[] = [
    ...defaultTools(cfg.workdir, { files: cfg.fileTools, bash: cfg.bash }),
  ];

  const skillLoader = new SkillLoader([
    paths.globalSkillsDir,
    paths.projectSkillsDir,
    ...(cfg.skillsDir ? [cfg.skillsDir] : []),
  ]);
  let skills = "(no skills available)";
  if (skillLoader.names().length > 0) {
    tools.push(loadSkillTool(skillLoader));
    skills = skillLoader.getDescriptions();
  }

  const spillEnabled = cfg.spill !== false;
  const spillStore = spillEnabled
    ? fileSpillStore({ dir: paths.spillDir })
    : undefined;
  if (spillStore) tools.push(readSpilledTool(spillStore));

  const tasksEnabled = cfg.tasks !== false;
  const taskStore = tasksEnabled
    ? fileTaskStore({
        dir: paths.tasksDir,
        listId: cfg.taskListId ?? process.env.LITE_AGENT_TASK_LIST_ID ?? "default",
      })
    : undefined;
  if (taskStore) tools.push(...taskTools(taskStore));

  let subagents: string | undefined;
  if (cfg.agents !== false) {
    const agentLoader = new AgentLoader(
      [
        paths.globalAgentsDir,
        paths.projectAgentsDir,
        ...(cfg.agentsDir ? [cfg.agentsDir] : []),
      ],
      builtinAgents(),
    );
    if (agentLoader.names().length > 0) {
      subagents = agentLoader.getDescriptions();
      tools.push(agentTool({ loader: agentLoader, spawn }));
    }
  }

  if (cfg.background !== false) {
    tools.push(killBackgroundTool(), bashOutputTool());
  }
  if (cfg.tools) tools.push(...cfg.tools);
  if (cfg.onAskUser) tools.push(askUserTool());
  if (cfg.allowedTools) {
    tools = tools.filter((entry) => cfg.allowedTools!.includes(entry.name));
  }
  if (cfg.disallowedTools) {
    tools = tools.filter((entry) => !cfg.disallowedTools!.includes(entry.name));
  }

  const outputs = new Map<string, unknown>();
  if (cfg.outputSchema) {
    tools.push(
      tool(
        "final_answer",
        "Call this exactly once, when the task is complete, to return your final answer. " +
          "Pass the result as the arguments. Do not call it before you are done.",
        cfg.outputSchema,
        (input, ctx) => {
          outputs.set(ctx.sessionId, input);
          return "Final answer recorded.";
        },
        { security: { network: "none", filesystem: "none", sideEffects: "none" } },
      ),
    );
  }

  let system =
    cfg.system ??
    buildSystemPrompt({
      workdir: cfg.workdir,
      modelName: cfg.modelName,
      skills,
      subagents,
    });
  if (cfg.outputSchema) {
    system +=
      "\n\n## Final answer\n" +
      "When you have fully completed the task, you MUST call the `final_answer` tool " +
      "exactly once with your result. Do not put the final result in a normal message — " +
      "only the `final_answer` tool call is read as the answer.";
  }

  const structuralCompactor =
    cfg.compactor === false
      ? undefined
      : cfg.compactor ??
        defaultCompactor({
          spillStore,
          budgetBytes:
            typeof cfg.spill === "object" ? cfg.spill.budgetBytes : undefined,
        });
  const budgetCompactor = cfg.contextBudget
    ? tokenBudgetCompactor(cfg.contextBudget)
    : undefined;
  const compactor: Compactor | undefined =
    structuralCompactor && budgetCompactor
      ? {
          async maybeCompact(messages, usage, instructions) {
            const first = await structuralCompactor.maybeCompact(
              messages,
              usage,
              instructions,
            );
            const second = await budgetCompactor.maybeCompact(
              first.messages,
              usage,
              instructions,
            );
            return second.messages === first.messages
              ? first
              : { ...second, before: first.before ?? second.before };
          },
        }
      : structuralCompactor ?? budgetCompactor;

  const checkpointer: Checkpointer | undefined =
    cfg.checkpointer ??
    (cfg.store
      ? legacyStoreAdapter(cfg.store)
      : cfg.sessions === false
        ? undefined
        : fileCheckpointer({ dir: paths.sessionsDir }));

  const use: Middleware[] = [
    ...(compactor ? [compaction(compactor), reactiveCompaction()] : []),
    ...(cfg.permission
      ? [
          permission(cfg.permission, cfg.onApproval, {
            redact: cfg.redact,
            mode: cfg.permissionMode,
            audit: cfg.permissionAudit,
          }),
        ]
      : []),
    ...(cfg.use ?? []),
    ...(taskStore ? [taskReminder(taskStore)] : []),
  ];

  const core = createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec: cfg.codec ?? nativeCodec(),
    tools,
    use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    topP: cfg.topP,
    toolChoice: cfg.toolChoice,
    seed: cfg.seed,
    maxParallelTools: cfg.maxParallelTools,
    maxDecodeRetries: cfg.maxDecodeRetries,
    background: cfg.background,
    backgroundLimits: cfg.backgroundLimits,
    crashRecovery: cfg.crashRecovery,
    maxSnapshotBytesPerSession: cfg.maxSnapshotBytesPerSession,
    sandbox: cfg.sandbox,
    checkpointer,
    input: cfg.onAskUser,
  });

  const takeOutput = cfg.outputSchema
    ? (sessionId: string): unknown => {
        const output = outputs.get(sessionId);
        outputs.delete(sessionId);
        return output;
      }
    : undefined;

  return { core, checkpointer, compactor, takeOutput };
}
```

Do not reorder statements while moving them. In particular, keep `final_answer` after both filters, the task reminder last, and `reactiveCompaction()` immediately after proactive compaction.

- [ ] **Step 3: Reduce `createLiteAgent.ts` to the composition root**

Replace the file with:

```ts
import { sweepStale } from "./cleanup";
import { resolveProjectPaths } from "./paths";
import { assembleLiteAgent } from "./liteAgentAssembly";
import { createLiteAgentFacade } from "./liteAgent";
import type { CreateLiteAgentConfig, LiteAgent } from "./liteAgent";
import type { Spawn } from "./tools/agent";

export type {
  CreateLiteAgentConfig,
  LiteAgent,
  LiteAgentResult,
} from "./liteAgent";

export function createLiteAgent(cfg: CreateLiteAgentConfig): LiteAgent {
  const paths = resolveProjectPaths({
    workdir: cfg.workdir,
    home: cfg.home,
  });

  if (cfg.cleanup !== false) {
    sweepStale({
      home: paths.home,
      maxAgeDays:
        typeof cfg.cleanup === "object"
          ? cfg.cleanup.maxAgeDays
          : undefined,
      maxBytes:
        typeof cfg.cleanup === "object"
          ? cfg.cleanup.maxBytes
          : undefined,
    });
  }

  const spawn: Spawn = async (
    definition,
    prompt,
    { signal, sessionId, onEvent },
  ) => {
    const child = createLiteAgent({
      ...cfg,
      system:
        `You are the "${definition.name}" subagent operating in ${cfg.workdir}. ` +
        `Return your final answer as your last message.\n\n${definition.body}`,
      modelName: definition.model ?? cfg.modelName,
      allowedTools: definition.tools ?? cfg.allowedTools,
      agents: false,
      cleanup: false,
      permission: cfg.subagentPermission,
      onApproval: undefined,
      onAskUser: undefined,
      outputSchema: undefined,
      checkpointer: cfg.checkpointer,
    });
    const gen = child.run(
      [{ role: "user", content: prompt }],
      { signal, sessionId },
    );
    let result = await gen.next();
    while (!result.done) {
      onEvent?.(result.value);
      result = await gen.next();
    }
    return result.value.text;
  };

  const runtime = assembleLiteAgent({ cfg, paths, spawn });
  return createLiteAgentFacade(runtime, cfg.workdir);
}
```

The child must receive `cfg.checkpointer`, not the selected `runtime.checkpointer`; changing this would alter default child persistence and inherited legacy-store behavior.

- [ ] **Step 4: Run the focused assembly/facade suites**

Run:

```bash
pnpm --filter @lite-agent/sdk exec vitest run test/createLiteAgent.test.ts test/defaults.test.ts test/outputSchema.test.ts test/checkpoint-wiring.test.ts test/sessions.test.ts test/restore.test.ts test/compact.test.ts test/time-travel-integration.test.ts test/subagents.test.ts
pnpm --filter @lite-agent/sdk typecheck
```

Expected: all selected tests pass and SDK typecheck succeeds.

- [ ] **Step 5: Validate unchanged SDK and local public consumers**

Run in this order:

```bash
pnpm --filter @lite-agent/sdk test
pnpm --filter @lite-agent/sdk build
pnpm --filter @lite-agent/local test
pnpm --filter @lite-agent/local typecheck
```

Expected: the full SDK suite passes, the SDK builds declarations, and unchanged local source passes tests/typecheck against the rebuilt SDK.

- [ ] **Step 6: Run full repository verification**

Run in this exact order:

```bash
pnpm -r build
pnpm -r test
pnpm -r typecheck
git diff --check
git status --short
```

Expected: every package builds; all offline tests pass; every package typechecks; the compatibility smoke test is not discovered; no whitespace errors; only the files listed in this plan are changed.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/sdk/src/createLiteAgent.ts packages/sdk/src/liteAgent.ts packages/sdk/src/liteAgentAssembly.ts
git commit -m "refactor(sdk): split lite agent composition"
```

## Completion criteria

- Characterization tests pass before and after extraction.
- `createLiteAgent.ts` is a thin composition root with no assembly/session implementation body.
- `liteAgentAssembly.ts` is internal and keeps all ordering rules explicit.
- `liteAgent.ts` owns public contracts and all mutable session state.
- The public package exports and unchanged `query.ts`/`local` consumers compile without source edits.
- No production behavior, dependency, persistence format, version, or changelog changes.
- Full workspace build, offline tests, and typecheck pass.
