import { expect, test } from "vitest";
import { translateStream } from "../src/openai/stream";
import type { ModelChunk } from "@lite-agent/core";

async function* chunks(...cs: unknown[]) {
  for (const c of cs) yield c as never;
}
async function collect(it: AsyncIterable<ModelChunk>) {
  const out: ModelChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

test("accumulates text deltas and a tool call split across chunks, plus usage", async () => {
  const out = await collect(
    translateStream(
      chunks(
        { choices: [{ delta: { content: "He" } }] },
        { choices: [{ delta: { content: "llo" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c1",
                    function: { name: "bash", arguments: '{"cmd":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }],
              },
            },
          ],
        },
        {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        },
      ),
    ),
  );
  expect(
    out
      .filter((c) => c.type === "text_delta")
      .map((c) => (c as { text: string }).text),
  ).toEqual(["He", "llo"]);
  const done = out.at(-1) as Extract<ModelChunk, { type: "message_done" }>;
  expect(done.type).toBe("message_done");
  expect(done.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  expect(done.message.content).toEqual([
    { type: "text", text: "Hello" },
    { type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" } },
  ]);
});

test("malformed tool arguments fall back to empty input", async () => {
  const out = await collect(
    translateStream(
      chunks(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c1",
                    function: { name: "t", arguments: "{bad" },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {} }] },
      ),
    ),
  );
  const done = out.at(-1) as Extract<ModelChunk, { type: "message_done" }>;
  expect(done.message.content).toEqual([
    { type: "tool_call", id: "c1", name: "t", input: {} },
  ]);
});
