import { expect, test } from "vitest";
import { toOpenAIParams } from "../src/openai/mapping";

test("prepends system, maps user/assistant text", () => {
  const p = toOpenAIParams({ model: "m", system: "sys", messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "yo" },
  ] });
  expect(p.model).toBe("m");
  expect(p.stream).toBe(true);
  expect(p.messages).toEqual([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "yo" },
  ]);
});

test("assistant tool_call blocks -> tool_calls; tool_result blocks -> role:tool messages", () => {
  const p = toOpenAIParams({ model: "m", messages: [
    { role: "assistant", content: [
      { type: "text", text: "calling" },
      { type: "tool_call", id: "c1", name: "bash", input: { command: "ls" } },
    ] },
    { role: "user", content: [{ type: "tool_result", id: "c1", content: "files" }] },
  ] });
  expect(p.messages[0]).toMatchObject({
    role: "assistant", content: "calling",
    tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }],
  });
  expect(p.messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "files" });
});

test("maps tools and maxTokens/stop, drops $schema", () => {
  const p = toOpenAIParams({ model: "m", messages: [], maxTokens: 100, stopSequences: ["X"],
    tools: [{ name: "t", description: "d", parameters: { $schema: "x", type: "object", properties: {} } }] });
  expect(p.max_tokens).toBe(100);
  expect(p.stop).toEqual(["X"]);
  expect(p.tools).toEqual([{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } }]);
});

test("forwards temperature/top_p/seed and maps tool_choice (only when tools present)", () => {
  const withTool = { model: "m", messages: [],
    tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] };
  const p = toOpenAIParams({ ...withTool, temperature: 0.2, topP: 0.9, seed: 42, toolChoice: "required" as const });
  expect(p.temperature).toBe(0.2);
  expect(p.top_p).toBe(0.9);
  expect(p.seed).toBe(42);
  expect(p.tool_choice).toBe("required");
  // a specific tool by name
  expect(toOpenAIParams({ ...withTool, toolChoice: { tool: "t" } }).tool_choice)
    .toEqual({ type: "function", function: { name: "t" } });
  // tool_choice is dropped when there are no tools (OpenAI would 400 otherwise)
  expect(toOpenAIParams({ model: "m", messages: [], toolChoice: "required" as const }).tool_choice).toBeUndefined();
});
