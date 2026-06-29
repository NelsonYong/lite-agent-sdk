import { expect, test } from "vitest";
import { toAnthropicParams } from "../src/anthropic/mapping";
import type { ModelRequest } from "@lite-agent/core";

test("hoists system, maps blocks, builds tools, strips $schema, defaults max_tokens", () => {
  const req: ModelRequest = {
    model: "m1",
    system: "you are x",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_call", id: "c1", name: "add", input: { a: 1 } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", id: "c1", content: "2" }],
      },
    ],
    tools: [
      {
        name: "add",
        description: "add",
        parameters: {
          $schema: "x",
          type: "object",
          properties: { a: { type: "number" } },
          required: ["a"],
        },
      },
    ],
  };
  const p = toAnthropicParams(req);
  expect(p.model).toBe("m1");
  expect(p.system).toBe("you are x");
  expect(p.max_tokens).toBe(4096);
  expect(p.stream).toBe(true);
  expect(p.messages).toEqual([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "c1", name: "add", input: { a: 1 } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "2" }],
    },
  ]);
  expect(p.tools).toEqual([
    {
      name: "add",
      description: "add",
      input_schema: {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"],
      },
    },
  ]);
});

test("uses provided maxTokens and omits tools/system when absent", () => {
  const p = toAnthropicParams({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 100,
  });
  expect(p.max_tokens).toBe(100);
  expect(p.tools).toBeUndefined();
  expect(p.system).toBeUndefined();
});

test("forwards temperature/top_p, maps tool_choice variants, ignores unsupported seed", () => {
  const base: ModelRequest = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
  };
  const p = toAnthropicParams({ ...base, temperature: 0.3, topP: 0.8, seed: 7, toolChoice: "required" });
  expect(p.temperature).toBe(0.3);
  expect(p.top_p).toBe(0.8);
  expect((p as { seed?: number }).seed).toBeUndefined(); // Anthropic has no seed
  expect(p.tool_choice).toEqual({ type: "any" });
  expect(toAnthropicParams({ ...base, toolChoice: "auto" }).tool_choice).toEqual({ type: "auto" });
  expect(toAnthropicParams({ ...base, toolChoice: "none" }).tool_choice).toEqual({ type: "none" });
  expect(toAnthropicParams({ ...base, toolChoice: { tool: "t" } }).tool_choice).toEqual({ type: "tool", name: "t" });
  // dropped when there are no tools
  expect(toAnthropicParams({ model: "m", messages: [{ role: "user", content: "hi" }], toolChoice: "required" }).tool_choice).toBeUndefined();
});
