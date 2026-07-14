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

test("runs with default tools wired", async () => {
  const agent = createLiteAgent({
    model: fakeProvider([
      {
        text: "ok",
        message: { role: "assistant", content: [textBlock("ok")] },
      },
    ]),
    workdir: process.cwd(),
  });
  expect((await agent.send("hi")).text).toBe("ok");
});

test("load_skill is wired when skillsDir is set", async () => {
  const root = mkdtempSync(join(tmpdir(), "sk-"));
  mkdirSync(join(root, "demo"));
  writeFileSync(
    join(root, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: d\n---\nBODY",
  );
  const fp = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "load_skill",
            input: { name: "demo" },
          },
        ],
      },
    },
    {
      text: "done",
      message: { role: "assistant", content: [textBlock("done")] },
    },
  ]);
  const agent = createLiteAgent({
    model: fp,
    workdir: process.cwd(),
    skillsDir: root,
  });
  const results: string[] = [];
  for await (const ev of agent.run("hi"))
    if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toContain("BODY");
});

test("allowedTools restricts the registered set", async () => {
  const fp = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "read_file",
            input: { path: "x" },
          },
        ],
      },
    },
    {
      text: "end",
      message: { role: "assistant", content: [textBlock("end")] },
    },
  ]);
  const agent = createLiteAgent({
    model: fp,
    workdir: process.cwd(),
    allowedTools: ["bash"],
  });
  const results: string[] = [];
  for await (const ev of agent.run("hi"))
    if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toMatch(/unknown tool/);
});

test("a configured store resumes the session across separate runs", async () => {
  const store = memoryStore();
  const make = (text: string) =>
    createLiteAgent({
      model: fakeProvider([{ text, message: { role: "assistant", content: [textBlock(text)] } }]),
      workdir: process.cwd(),
      store,
    });
  await make("one").send("first", { sessionId: "x" });
  const r2 = await make("two").send("second", { sessionId: "x" });
  expect(r2.messages).toContainEqual({ role: "user", content: "first" });
  expect(r2.messages).toContainEqual({ role: "user", content: "second" });
});

test("a configured compactor plugs in and emits compaction on a run", async () => {
  const shrink = {
    async maybeCompact(messages: { role: string; content: unknown }[]) {
      return messages.length <= 1
        ? { messages, before: 1, after: 1 }
        : { messages: [messages[0]!], kind: "micro" as const, before: 10, after: 1 };
    },
  };
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "bash", input: { command: "echo hi" } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: process.cwd(), compactor: shrink as any });
  const types: string[] = [];
  for await (const ev of agent.run("hi")) types.push(ev.type);
  expect(types).toContain("compaction");
});

test("compactor wiring includes the reactive net — recovers from prompt_too_long", async () => {
  let calls = 0;
  const provider = {
    id: "ov",
    async *stream() {
      calls++;
      if (calls === 1) throw new ProviderError("prompt is too long", 413);
      yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const turn = (u: string, id: string, r: string): Message[] => [
    { role: "user", content: u },
    { role: "assistant", content: [{ type: "tool_call", id, name: "f", input: {} }] },
    { role: "user", content: [{ type: "tool_result", id, content: r }] },
  ];
  const history = [0, 1, 2, 3, 4, 5].flatMap((i) => turn(`q${i}`, `c${i}`, `r${i}`));
  const agent = createLiteAgent({ model: provider as any, workdir: process.cwd(), compactor: defaultCompactor() });
  const result = await agent.send(history);
  expect(calls).toBe(2);
  expect(result.text).toBe("ok");
});

test("a configured sandbox wraps bash commands end-to-end", async () => {
  const fp = fakeProvider([
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "bash",
            input: { command: "echo original" },
          },
        ],
      },
    },
    {
      text: "done",
      message: { role: "assistant", content: [textBlock("done")] },
    },
  ]);
  const agent = createLiteAgent({
    model: fp,
    workdir: process.cwd(),
    sandbox: { id: "fake", wrap: () => "echo wrapped-by-sandbox" },
  });
  const results: string[] = [];
  for await (const ev of agent.run("hi"))
    if (ev.type === "tool_result") results.push(ev.result.content);
  expect(results.join("")).toContain("wrapped-by-sandbox");
  expect(results.join("")).not.toContain("original");
});

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
