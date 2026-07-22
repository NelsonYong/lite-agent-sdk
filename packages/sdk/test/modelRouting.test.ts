import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ModelRequest } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { query } from "../src/query";

function recordingProvider(id: string, seen: string[]): ModelProvider {
  return {
    id,
    async *stream(request: ModelRequest) {
      seen.push(request.model);
      yield { type: "text_delta", text: "ok" };
      yield {
        type: "message_done",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

const workdir = () => mkdtempSync(join(tmpdir(), "model-routing-"));

function agentDefinitions(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "model-routing-agents-"));
  writeFileSync(join(dir, "worker.md"), contents);
  return dir;
}

test("createLiteAgent uses defaultModel profile provider and model id", async () => {
  const seen: string[] = [];
  const simple = recordingProvider("simple", seen);
  const medium = recordingProvider("medium", seen);
  const complex = recordingProvider("complex", seen);
  const agent = createLiteAgent({
    models: {
      simple: { provider: simple, modelName: "fast-id", displayName: "Fast" },
      medium: { provider: medium, modelName: "balanced-id", displayName: "Balanced" },
      complex: { provider: complex, modelName: "strong-id", displayName: "Strong" },
    },
    defaultModel: "complex",
    workdir: process.cwd(),
    sessions: false,
    cleanup: false,
    agents: false,
    tasks: false,
    background: false,
  });
  await agent.send("hello");
  expect(seen).toEqual(["strong-id"]);
  await agent.close();
});

test("query forwards models and defaultModel", async () => {
  const seen: string[] = [];
  const gen = query({
    prompt: "hello",
    models: {
      simple: { provider: recordingProvider("simple", seen), modelName: "fast-id" },
      medium: { provider: recordingProvider("medium", seen), modelName: "balanced-id" },
      complex: { provider: recordingProvider("complex", seen), modelName: "strong-id" },
    },
    defaultModel: "simple",
    cwd: process.cwd(),
    sessions: false,
    cleanup: false,
    agents: false,
    tasks: false,
    background: false,
  });
  while (!(await gen.next()).done) {}
  expect(seen).toEqual(["fast-id"]);
});

test("createLiteAgent retains legacy model and modelName", async () => {
  const seen: string[] = [];
  const agent = createLiteAgent({
    model: recordingProvider("legacy", seen),
    modelName: "legacy-id",
    workdir: process.cwd(),
    sessions: false,
    cleanup: false,
    agents: false,
    tasks: false,
    background: false,
  });
  await agent.send("hello");
  expect(seen).toEqual(["legacy-id"]);
  await agent.close();
});

type ProviderCall = { provider: string; model: string; child: boolean };

async function runSubagentRoute(opts: { taskModel?: string; definitionModel?: string }): Promise<ProviderCall[]> {
  const calls: ProviderCall[] = [];
  let parentCalls = 0;
  const provider = (id: string): ModelProvider => ({
    id,
    async *stream(request) {
      const child = request.system?.startsWith('You are the "worker" subagent') ?? false;
      calls.push({ provider: id, model: request.model, child });
      if (child) {
        yield { type: "text_delta", text: "child done" };
        yield {
          type: "message_done",
          message: { role: "assistant", content: [{ type: "text", text: "child done" }] },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{
              type: "tool_call",
              id: "agent-1",
              name: "Agent",
              input: {
                tasks: [{
                  display_name: "Worker",
                  subagent_type: "worker",
                  prompt: "go",
                  ...(opts.taskModel === undefined ? {} : { model: opts.taskModel }),
                }],
              },
            }],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      yield { type: "text_delta", text: "parent done" };
      yield {
        type: "message_done",
        message: { role: "assistant", content: [{ type: "text", text: "parent done" }] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  });
  const agent = createLiteAgent({
    models: {
      simple: { provider: provider("simple"), modelName: "simple-id" },
      medium: { provider: provider("medium"), modelName: "medium-id" },
      complex: { provider: provider("complex"), modelName: "complex-id" },
    },
    defaultModel: "medium",
    workdir: workdir(),
    agentsDir: agentDefinitions(`---\nname: worker\ndescription: worker${opts.definitionModel === undefined ? "" : `\nmodel: ${opts.definitionModel}`}\n---\nworker`),
    sessions: false,
    cleanup: false,
    tasks: false,
  });
  await agent.send("start");
  await agent.awaitIdle();
  await agent.close();
  return calls;
}

test("subagent task model wins over definition model and switches tier provider", async () => {
  const child = (await runSubagentRoute({ taskModel: "complex", definitionModel: "simple" }))
    .filter((call) => call.child);
  expect(child).toEqual([{ provider: "complex", model: "complex-id", child: true }]);
});

test("subagent definition model selects its tier when task has no model", async () => {
  const child = (await runSubagentRoute({ definitionModel: "simple" }))
    .filter((call) => call.child);
  expect(child).toEqual([{ provider: "simple", model: "simple-id", child: true }]);
});

test("subagent without model selection inherits the active root profile", async () => {
  const child = (await runSubagentRoute({}))
    .filter((call) => call.child);
  expect(child).toEqual([{ provider: "medium", model: "medium-id", child: true }]);
});

test("raw subagent model id keeps the inherited active provider", async () => {
  const child = (await runSubagentRoute({ taskModel: "raw-child-id" }))
    .filter((call) => call.child);
  expect(child).toEqual([{ provider: "medium", model: "raw-child-id", child: true }]);
});
