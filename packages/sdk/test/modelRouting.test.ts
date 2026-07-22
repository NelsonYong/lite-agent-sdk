import { expect, test } from "vitest";
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
