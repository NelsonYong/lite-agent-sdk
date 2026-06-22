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
