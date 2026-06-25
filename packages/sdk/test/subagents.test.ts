import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock } from "@lite-agent/core";
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
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "echo", prompt: "hi", resume: "agent-echo-fixed1" }] } }] } },
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
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "Agent", input: { tasks: [{ subagent_type: "general-purpose", prompt: "do it", resume: "agent-gp-default1" }] } }] } },
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
