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

test("subagent task model wins over definition model and switches tier provider", async () => {
  const rootSeen: string[] = [];
  const simpleSeen: string[] = [];
  const complexSeen: string[] = [];
  let rootCalls = 0;
  const root: ModelProvider = {
    id: "medium",
    async *stream(request) {
      rootSeen.push(request.model);
      rootCalls += 1;
      if (rootCalls === 1) {
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{
              type: "tool_call",
              id: "agent-1",
              name: "Agent",
              input: { tasks: [{ display_name: "Worker", subagent_type: "worker", prompt: "go", model: "complex" }] },
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
  };
  const simple = recordingProvider("simple", simpleSeen);
  const complex = recordingProvider("complex", complexSeen);
  const agent = createLiteAgent({
    models: {
      simple: { provider: simple, modelName: "simple-id" },
      medium: { provider: root, modelName: "medium-id" },
      complex: { provider: complex, modelName: "complex-id" },
    },
    defaultModel: "medium",
    workdir: workdir(),
    agentsDir: agentDefinitions("---\nname: worker\ndescription: worker\nmodel: simple\n---\nworker"),
    sessions: false,
    cleanup: false,
    tasks: false,
  });
  await agent.send("start");
  await agent.awaitIdle();
  expect(rootSeen.length).toBeGreaterThanOrEqual(2);
  expect(rootSeen.every((model) => model === "medium-id")).toBe(true);
  expect(simpleSeen).toEqual([]);
  expect(complexSeen).toEqual(["complex-id"]);
  await agent.close();
});
