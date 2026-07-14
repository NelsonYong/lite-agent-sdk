import { expect, test } from "vitest";
import type { ModelChunk, ModelRequest } from "@lite-agent/core";
import { openai } from "../../src/openai";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for test:compat`);
  return value;
}

function optionalBoolean(name: string): boolean {
  const value = process.env[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}

const baseURL = required("LITE_AGENT_COMPAT_BASE_URL");
const model = required("LITE_AGENT_COMPAT_MODEL");
const apiKey = process.env["LITE_AGENT_COMPAT_API_KEY"] ?? "local";
const forcedTool = optionalBoolean("LITE_AGENT_COMPAT_FORCED_TOOL");
const provider = openai({ apiKey, baseURL });

async function collect(req: ModelRequest): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of provider.stream(req, AbortSignal.timeout(110_000))) {
    chunks.push(chunk);
  }
  return chunks;
}

test("streams text and emits one final normalized message", async () => {
  const chunks = await collect({
    model,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    maxTokens: 32,
    temperature: 0,
  });
  const deltas = chunks.flatMap((chunk) =>
    chunk.type === "text_delta" ? [chunk.text] : [],
  );
  expect(deltas.length).toBeGreaterThan(0);

  const done = chunks.filter(
    (chunk): chunk is Extract<ModelChunk, { type: "message_done" }> =>
      chunk.type === "message_done",
  );
  expect(done).toHaveLength(1);
  const final = done[0];
  if (!final) throw new Error("missing message_done");
  expect(chunks.at(-1)).toEqual(final);

  const finalText = final.message.content.flatMap((block) =>
    block.type === "text" ? [block.text] : [],
  ).join("");
  expect(finalText).toBe(deltas.join(""));
  expect(Number.isFinite(final.usage.inputTokens)).toBe(true);
  expect(Number.isFinite(final.usage.outputTokens)).toBe(true);
  expect(final.usage.inputTokens).toBeGreaterThanOrEqual(0);
  expect(final.usage.outputTokens).toBeGreaterThanOrEqual(0);
  if (final.usage.inputTokens + final.usage.outputTokens === 0) {
    console.warn("compatibility profile: endpoint did not report token usage");
  }
});

if (forcedTool) {
  test("supports forced selection of a named tool", async () => {
    const chunks = await collect({
      model,
      messages: [{
        role: "user",
        content: "Call the echo tool with value pong. Do not answer in text.",
      }],
      tools: [{
        name: "echo",
        description: "Echo a string value",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      }],
      toolChoice: { tool: "echo" },
      maxTokens: 64,
      temperature: 0,
    });
    const final = chunks.at(-1);
    if (final?.type !== "message_done") throw new Error("missing message_done");
    const call = final.message.content.find(
      (block) => block.type === "tool_call",
    );
    expect(call).toMatchObject({
      type: "tool_call",
      name: "echo",
      input: { value: "pong" },
    });
  });
}
