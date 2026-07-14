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

function agentsDir(name: string, body = `${name} body`): string {
  const d = mkdtempSync(join(tmpdir(), "sa-"));
  writeFileSync(join(d, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\n---\n${body}`);
  return d;
}

// A hermetic per-test project root so sessions/tasks never bleed between tests.
const workdir = () => mkdtempSync(join(tmpdir(), "wd-"));

// One fakeProvider instance is shared by parent and child kernels; its turn counter
// advances once per model call, so turns run in deterministic order:
// parent-turn1 (Agent call) -> child-turn1 -> parent-turn2.
function collectResults(gen: AsyncGenerator<{ type: string }, unknown>) {
  return (async () => {
    const out: string[] = [];
    for await (const ev of gen as AsyncGenerator<any>)
      if (ev.type === "tool_result") out.push(ev.result.content);
    return out;
  })();
}

test("registers the Agent tool and runs a child to completion when a definition exists", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "echo", prompt: "hi", resume: "agent-echo-fixed1" }], run_in_background: false } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: workdir(), agentsDir: agentsDir("echo") });
  const results = await collectResults(agent.run("start"));
  expect(results.join("")).toContain("child-done");
  expect(results.join("")).toContain("agentId: agent-echo-fixed1");
  expect(results.join("")).not.toMatch(/unknown tool/);
});

test("the built-in general-purpose subagent works with no agent files (default on)", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "general-purpose", prompt: "do it", resume: "agent-gp-default1" }], run_in_background: false } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  // No agentsDir, fresh empty workdir → only the built-in general-purpose exists.
  const agent = createLiteAgent({ model: fp, workdir: workdir() });
  const results = await collectResults(agent.run("start"));
  expect(results.join("")).toContain("child-done");
  expect(results.join("")).toContain("agentId: agent-gp-default1");
  expect(results.join("")).not.toMatch(/unknown tool/);
});

test("agents:false leaves the Agent tool unregistered", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "echo", prompt: "hi" }] } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: workdir(), agentsDir: agentsDir("echo"), agents: false });
  const results = await collectResults(agent.run("start"));
  expect(results.join("")).toMatch(/unknown tool 'Agent'/);
});

test("a subagent run persists a durable transcript under sessionsDir", async () => {
  const wd = workdir();
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "echo", prompt: "hi", resume: "agent-echo-persist1" }] } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: wd, agentsDir: agentsDir("echo") });
  await collectResults(agent.run("start"));
  const paths = resolveProjectPaths({ workdir: wd });
  const files = readdirSync(paths.sessionsDir);
  expect(files).toContain("agent-echo-persist1.jsonl");
});

test("a spawned child has no Agent tool (no recursion)", async () => {
  const wd = workdir();
  const fp = fakeProvider([
    // parent dispatches the child...
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "echo", prompt: "hi", resume: "agent-echo-norecurse" }] } }] } },
    // ...child tries to dispatch its OWN subagent — it must have no Agent tool...
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "Agent", input: { tasks: [{ subagent_type: "echo", prompt: "again" }] } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: wd, agentsDir: agentsDir("echo") });
  await collectResults(agent.run("start"));
  const paths = resolveProjectPaths({ workdir: wd });
  const transcript = readFileSync(join(paths.sessionsDir, "agent-echo-norecurse.jsonl"), "utf8");
  expect(transcript).toContain("unknown tool 'Agent'");
});

test("a subagent shares the project task list with its parent", async () => {
  const wd = workdir();
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "tasker", prompt: "make a task", resume: "agent-tasker-share1" }] } }] } },
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "TaskCreate", input: { subject: "from child", description: "d" } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: wd, agentsDir: agentsDir("tasker") });
  await collectResults(agent.run("start"));
  const paths = resolveProjectPaths({ workdir: wd });
  const store = fileTaskStore({ dir: paths.tasksDir, listId: "default" });
  expect(store.list().some((t) => t.subject === "from child")).toBe(true);
});

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
