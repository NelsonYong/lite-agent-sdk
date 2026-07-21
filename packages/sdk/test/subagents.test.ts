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
  Tool,
} from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import type { LiteAgent } from "../src/liteAgent";
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

async function collectUntilIdle(
  agent: LiteAgent,
  input: string,
  sessionId = agent.sessionId,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const unsubscribe = agent.subscribe((entry) => {
    if (entry.sessionId === sessionId) events.push(entry.event);
  });
  await collectResults(agent.run(input, { sessionId }));
  await agent.awaitIdle(sessionId);
  unsubscribe();
  return events;
}

const toolResults = (events: AgentEvent[]): string[] => events.flatMap((event) =>
  event.type === "tool_result" ? [event.result.content] : []);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const lastText = (request: ModelRequest): string | undefined => {
  const message = request.messages.at(-1);
  return message?.role === "user" && typeof message.content === "string"
    ? message.content
    : undefined;
};

test("registers the Agent tool and runs a child to completion when a definition exists", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ display_name: "Echo", subagent_type: "echo", prompt: "hi", resume: "agent-echo-fixed1" }], run_in_background: false } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: workdir(), agentsDir: agentsDir("echo") });
  const events = await collectUntilIdle(agent, "start");
  const results = toolResults(events);
  expect(results.join("")).toContain("child-done");
  expect(events.some((event) =>
    event.type === "background_completed" && event.completion.content.includes("agentId: agent-echo-fixed1"),
  )).toBe(true);
  expect(results.join("")).not.toMatch(/unknown tool/);
  await agent.close();
});

test("the built-in general-purpose subagent works with no agent files (default on)", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ display_name: "General", subagent_type: "general-purpose", prompt: "do it", resume: "agent-gp-default1" }], run_in_background: false } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  // No agentsDir, fresh empty workdir → only the built-in general-purpose exists.
  const agent = createLiteAgent({ model: fp, workdir: workdir() });
  const events = await collectUntilIdle(agent, "start");
  const results = toolResults(events);
  expect(results.join("")).toContain("child-done");
  expect(events.some((event) =>
    event.type === "background_completed" && event.completion.content.includes("agentId: agent-gp-default1"),
  )).toBe(true);
  expect(results.join("")).not.toMatch(/unknown tool/);
  await agent.close();
});

test("agents:false leaves the Agent tool unregistered", async () => {
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ display_name: "Echo", subagent_type: "echo", prompt: "hi" }] } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: workdir(), agentsDir: agentsDir("echo"), agents: false });
  const results = await collectResults(agent.run("start"));
  expect(results.join("")).toMatch(/unknown tool 'Agent'/);
  await agent.close();
});

test("a subagent run persists a durable transcript under sessionsDir", async () => {
  const wd = workdir();
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ display_name: "Echo", subagent_type: "echo", prompt: "hi", resume: "agent-echo-persist1" }] } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: wd, agentsDir: agentsDir("echo") });
  await collectUntilIdle(agent, "start");
  const paths = resolveProjectPaths({ workdir: wd });
  const files = readdirSync(paths.sessionsDir);
  expect(files).toContain("agent-echo-persist1.jsonl");
  await agent.close();
});

test("a spawned child has no Agent tool (no recursion)", async () => {
  const wd = workdir();
  const fp = fakeProvider([
    // parent dispatches the child...
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ display_name: "Echo", subagent_type: "echo", prompt: "hi", resume: "agent-echo-norecurse" }] } }] } },
    // ...child tries to dispatch its OWN subagent — it must have no Agent tool...
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "Agent", input: { tasks: [{ display_name: "Nested", subagent_type: "echo", prompt: "again" }] } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: wd, agentsDir: agentsDir("echo") });
  await collectUntilIdle(agent, "start");
  const paths = resolveProjectPaths({ workdir: wd });
  const transcript = readFileSync(join(paths.sessionsDir, "agent-echo-norecurse.jsonl"), "utf8");
  expect(transcript).toContain("unknown tool 'Agent'");
  await agent.close();
});

test("a root Agent dispatcher filters a custom Agent tool before creating its child", async () => {
  const inheritedTools: Tool[] = [];
  const customAgent = defineTool({
    name: "Agent",
    description: "custom Agent marker",
    schema: z.object({}),
    execute: vi.fn(() => "custom Agent ran"),
  });
  const requests: ModelRequest[] = [];
  const inner = fakeProvider([
    // The root was assembled before customAgent was added, so this reaches the
    // built-in dispatcher and creates the child below.
    { message: { role: "assistant", content: [{ type: "tool_call", id: "p1", name: "Agent", input: { tasks: [{ display_name: "Worker", subagent_type: "worker", prompt: "child", resume: "agent-worker-custom-agent" }] } }] } },
    // A leaked custom Agent would execute here instead of producing unknown tool.
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "Agent", input: {} }] } },
    { text: "child done", message: { role: "assistant", content: [textBlock("child done")] } },
    { text: "parent done", message: { role: "assistant", content: [textBlock("parent done")] } },
  ]);
  const model: ModelProvider = {
    id: "custom-agent-recorder",
    stream(request, signal) {
      requests.push(request);
      return inner.stream(request, signal);
    },
  };
  const agent = createLiteAgent({
    model,
    workdir: workdir(),
    agentsDir: agentsDir("worker"),
    tools: inheritedTools,
  });

  inheritedTools.push(customAgent);
  const events = await collectUntilIdle(agent, "start");

  expect(requests[1]?.tools?.map((tool) => tool.name)).not.toContain("Agent");
  expect(events).toContainEqual(expect.objectContaining({
    agentId: "agent-worker-custom-agent",
    type: "tool_result",
    result: expect.objectContaining({
      name: "Agent",
      content: "Error: unknown tool 'Agent'",
      isError: true,
    }),
  }));
  expect(customAgent.execute).not.toHaveBeenCalled();
  await agent.close();
});

test("a subagent shares the project task list with its parent", async () => {
  const wd = workdir();
  const fp = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ display_name: "Tasker", subagent_type: "tasker", prompt: "make a task", resume: "agent-tasker-share1" }] } }] } },
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "TaskCreate", input: { subject: "from child", description: "d" } }] } },
    { text: "child-done", message: { role: "assistant", content: [textBlock("child-done")] } },
    { text: "parent-done", message: { role: "assistant", content: [textBlock("parent-done")] } },
  ]);
  const agent = createLiteAgent({ model: fp, workdir: wd, agentsDir: agentsDir("tasker") });
  await collectUntilIdle(agent, "start");
  const paths = resolveProjectPaths({ workdir: wd });
  const store = fileTaskStore({ dir: paths.tasksDir, listId: "default" });
  expect(store.list().some((t) => t.subject === "from child")).toBe(true);
  await agent.close();
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
              display_name: "Worker",
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
    sessions: false,
    cleanup: false,
    compactor: false,
  });

  await collectUntilIdle(agent, "start");

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
  await agent.close();
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
              display_name: "Worker",
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
    cleanup: false,
    compactor: false,
  });
  const events = await collectUntilIdle(agent, "start");

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
  await agent.close();
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
                display_name: "Worker",
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
  await collectUntilIdle(withCheckpointer, "start");
  expect(await checkpointer.head("agent-worker-cp")).toBeGreaterThan(0);
  await withCheckpointer.close();

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
                display_name: "Worker",
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
  await collectUntilIdle(withStore, "start");
  expect(await store.load("agent-worker-store")).toContainEqual({
    role: "user",
    content: "store prompt",
  });
  await withStore.close();
});

test("two Agent groups share maxParallelSubagents across all six children", async () => {
  const gate = deferred();
  let running = 0;
  let maxRunning = 0;
  let completed = 0;
  const model: ModelProvider = {
    id: "shared-subagent-pool",
    async *stream(request) {
      if (request.system?.startsWith('You are the "worker" subagent')) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running--;
        completed++;
        yield {
          type: "message_done",
          message: { role: "assistant", content: [textBlock("child done")] },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }

      const prompt = lastText(request);
      if (prompt === "first" || prompt === "second") {
        const prefix = prompt === "first" ? "A" : "B";
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{
              type: "tool_call",
              id: `dispatch-${prefix}`,
              name: "Agent",
              input: {
                tasks: [1, 2, 3].map((index) => ({
                  display_name: `${prefix}${index}`,
                  subagent_type: "worker",
                  prompt: `${prefix}${index}`,
                })),
              },
            }],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }

      yield {
        type: "message_done",
        message: { role: "assistant", content: [textBlock("idle")] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  const agent = createLiteAgent({
    model,
    workdir: workdir(),
    agentsDir: agentsDir("worker"),
    maxParallelSubagents: 2,
    tasks: false,
    sessions: false,
    cleanup: false,
  });
  const backgroundCompletions: AgentEvent[] = [];
  agent.subscribe((entry) => {
    if (entry.sessionId === "shared" && entry.source === "background" && entry.event.type === "background_completed") {
      backgroundCompletions.push(entry.event);
    }
  });

  expect((await agent.send("first", { sessionId: "shared" })).text).toBe("idle");
  expect((await agent.send("second", { sessionId: "shared" })).text).toBe("idle");
  await vi.waitFor(() => expect(running).toBe(2));
  gate.resolve();
  await agent.awaitIdle("shared");

  expect(completed).toBe(6);
  expect(maxRunning).toBe(2);
  expect(backgroundCompletions).toHaveLength(2);
  await agent.close();
});

test("child max_turns and empty final text make the persisted group partial", async () => {
  const checkpointer = memoryCheckpointer();
  const definitions = agentsDir("maxer");
  writeFileSync(
    join(definitions, "empty.md"),
    "---\nname: empty\ndescription: empty agent\n---\nempty body",
  );
  writeFileSync(
    join(definitions, "worker.md"),
    "---\nname: worker\ndescription: worker agent\n---\nworker body",
  );
  const model: ModelProvider = {
    id: "terminal-child-results",
    async *stream(request) {
      if (request.system?.startsWith('You are the "maxer" subagent')) {
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{ type: "tool_call", id: `loop-${request.messages.length}`, name: "missing", input: {} }],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      if (request.system?.startsWith('You are the "empty" subagent')) {
        yield {
          type: "message_done",
          message: { role: "assistant", content: [] },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      if (request.system?.startsWith('You are the "worker" subagent')) {
        yield {
          type: "message_done",
          message: { role: "assistant", content: [textBlock("worker success")] },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      if (lastText(request) === "start") {
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{
              type: "tool_call",
              id: "terminal-dispatch",
              name: "Agent",
              input: {
                tasks: [
                  { display_name: "Max turns", subagent_type: "maxer", prompt: "loop" },
                  { display_name: "Empty", subagent_type: "empty", prompt: "empty" },
                  { display_name: "Worker", subagent_type: "worker", prompt: "success" },
                ],
              },
            }],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      yield {
        type: "message_done",
        message: { role: "assistant", content: [textBlock("handled")] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  const agent = createLiteAgent({
    model,
    workdir: workdir(),
    agentsDir: definitions,
    maxTurns: 2,
    checkpointer,
    tasks: false,
    cleanup: false,
  });
  await collectUntilIdle(agent, "start", "terminal-results");

  const stored = [];
  for await (const entry of checkpointer.read("terminal-results")) stored.push(entry);
  const completion = stored.find((entry) =>
    entry.event.type === "user" &&
    typeof entry.event.message.content === "string" &&
    entry.event.message.content.includes("background-task-completed"));
  expect(completion?.event).toMatchObject({ type: "user" });
  const content = completion?.event.type === "user"
    ? String(completion.event.message.content)
    : "";
  expect(content).toContain('status="partial"');
  expect(content).toContain("Subagent reached max turns");
  expect(content).toContain("Subagent stopped without a final answer");
  await agent.close();
});

test("background:false makes Agent fail explicitly without starting a child", async () => {
  const agent = createLiteAgent({
    model: fakeProvider([
      {
        message: {
          role: "assistant",
          content: [{
            type: "tool_call",
            id: "disabled-agent",
            name: "Agent",
            input: {
              tasks: [{ display_name: "Worker", subagent_type: "worker", prompt: "go" }],
            },
          }],
        },
      },
      { text: "handled", message: { role: "assistant", content: [textBlock("handled")] } },
    ]),
    workdir: workdir(),
    agentsDir: agentsDir("worker"),
    background: false,
    tasks: false,
    sessions: false,
    cleanup: false,
  });

  const results = await collectResults(agent.run("start"));
  expect(results.join("\n")).toContain("Agent requires background tasks");
  await agent.close();
});
