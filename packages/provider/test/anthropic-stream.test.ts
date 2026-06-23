import { expect, test } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelChunk } from "@lite-agent/core";
import { translateStream } from "../src/anthropic/stream";

async function* gen(events: Anthropic.RawMessageStreamEvent[]) {
  for (const e of events) yield e;
}

test("translates text + tool_use stream into ModelChunks", async () => {
  const events = [
    {
      type: "message_start",
      message: { usage: { input_tokens: 10, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t1", name: "add", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"a":1,' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"b":2}' },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 7 },
    },
    { type: "message_stop" },
  ] as unknown as Anthropic.RawMessageStreamEvent[];

  const chunks: ModelChunk[] = [];
  for await (const c of translateStream(gen(events))) chunks.push(c);

  const deltas = chunks.filter((c) => c.type === "text_delta");
  expect(
    deltas.map((d) => (d.type === "text_delta" ? d.text : "")).join(""),
  ).toBe("Hello world");

  const done = chunks.at(-1);
  expect(done?.type).toBe("message_done");
  if (done?.type === "message_done") {
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 7 });
    expect(done.message.content).toEqual([
      { type: "text", text: "Hello world" },
      { type: "tool_call", id: "t1", name: "add", input: { a: 1, b: 2 } },
    ]);
  }
});
