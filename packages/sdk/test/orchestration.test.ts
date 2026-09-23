import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ModelProvider, ModelRequest } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { fileTaskStore } from "../src/tasks/store";
import { resolveProjectPaths } from "../src/paths";
import { query } from "../src/query";

test("delegation resolves reasoning profiles and records success for review separately from failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-"));
  const home = join(root, "home");
  const calls: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  let parentCalls = 0;
  const provider: ModelProvider = {
    id: "test-model",
    async *stream(request) {
      calls.push(request);
      const child = request.system?.startsWith('You are the "general-purpose"');
      if (child && request.model === "strong") throw new Error("synthetic provider failure");
      const content = !child && parentCalls++ === 0
        ? [{ type: "tool_call" as const, id: "dispatch", name: "Agent", input: { tasks: [
            { display_name: "Lookup", subagent_type: "general-purpose", prompt: "lookup", model: "simple" },
            { display_name: "Review", subagent_type: "general-purpose", prompt: "review", model: "complex" },
          ] } }]
        : [{ type: "text" as const, text: "finished" }];
      yield { type: "message_done", message: { role: "assistant", content }, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const agent = createLiteAgent({
    models: {
      medium: { provider, modelName: "main" },
      simple: { provider, modelName: "fast", reasoningEffort: "low" },
      complex: { provider, modelName: "strong", reasoningEffort: "high" },
    },
    defaultModel: "medium", workdir: root, home, sessions: false, context: false, cleanup: false,
  });
  const unsubscribe = agent.subscribe(({ event }) => events.push(event));
  try {
    await agent.send("delegate");
    await agent.awaitIdle();
    expect(calls).toContainEqual(expect.objectContaining({ model: "fast", reasoningEffort: "low" }));
    expect(calls).toContainEqual(expect.objectContaining({ model: "strong", reasoningEffort: "high" }));
    expect(calls[0]?.system).toContain("simple: bounded read-only lookup");
    const dispatch = calls[0]?.tools?.find((tool) => tool.name === "Agent");
    expect(JSON.stringify(dispatch?.parameters)).toContain('"enum":["medium","simple","complex"]');
    expect(events).toContainEqual(expect.objectContaining({ type: "model_call_start", model: "fast", reasoningEffort: "low", agentId: expect.any(String) }));
    const completionRequest = calls.filter((r) => r.model === "main").at(-1)!;
    expect(completionRequest.messages).toContainEqual({ role: "user", content: "delegate" });
    const store = fileTaskStore({ dir: resolveProjectPaths({ workdir: root, home }).tasksDir, listId: agent.sessionId });
    expect(store.list().find((t) => t.subject === "Lookup")).toMatchObject({ status: "review", execution: { status: "succeeded", result: "finished" } });
    expect(store.list().find((t) => t.subject === "Review")).toMatchObject({ status: "failed", execution: { status: "failed" } });
    expect(store.list().some((t) => t.status === "completed")).toBe(false);
  } finally { unsubscribe(); await agent.close(); }
});

test("task reminders are isolated between sessions unless an explicit shared list is selected", async () => {
  const root = mkdtempSync(join(tmpdir(), "task-session-"));
  const home = join(root, "home");
  const requests: ModelRequest[] = [];
  const model: ModelProvider = { id: "recorder", async *stream(request) {
    requests.push(request);
    yield { type: "message_done", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const agent = createLiteAgent({ model, workdir: root, home, sessions: false, context: false, agents: false, cleanup: false });
  const store = fileTaskStore({ dir: resolveProjectPaths({ workdir: root, home }).tasksDir, listId: "session-a" });
  await store.create({ subject: "PRIVATE_TASK_MARKER", description: "d" });
  try {
    await agent.send("hi", { sessionId: "session-a" });
    await agent.send("hi", { sessionId: "session-b" });
    expect(JSON.stringify(requests[0]?.messages)).toContain("PRIVATE_TASK_MARKER");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("PRIVATE_TASK_MARKER");
  } finally { await agent.close(); }
});

test("query uses canonical SDK options and refuses conflicting aliases", async () => {
  const seen: ModelRequest[] = [];
  const model: ModelProvider = { id: "query-test", async *stream(request) {
    seen.push(request);
    yield { type: "message_done", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const root = mkdtempSync(join(tmpdir(), "query-config-"));
  const options = { model, workdir: root, home: join(root, "home"), sessions: false, tasks: false, agents: false, cleanup: false };
  for await (const _ of query({ ...options, prompt: "hi", system: "custom", reasoningEffort: "low" })) { /* drain */ }
  expect(seen[0]).toMatchObject({ system: "custom", reasoningEffort: "low" });
  expect(() => query({ ...options, prompt: "hi", cwd: "/different" })).toThrow(/conflict/);
  expect(() => query({ ...options, prompt: "hi", system: "a", systemPrompt: "b" })).toThrow(/conflict/);
});
