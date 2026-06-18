import { expect, test } from "vitest";
import { fakeProvider } from "../src/testing/fakeProvider";
import { textBlock } from "../src/types";
import type { ModelChunk } from "../src/types";

test("fakeProvider streams text deltas then a message_done", async () => {
  const provider = fakeProvider([
    { text: "hi", message: { role: "assistant", content: [textBlock("hi")] } },
  ]);
  const chunks: ModelChunk[] = [];
  for await (const c of provider.stream({ model: "fake", messages: [] })) chunks.push(c);
  expect(chunks.map((c) => c.type)).toEqual(["text_delta", "text_delta", "message_done"]);
});

test("fakeProvider advances turn by turn, repeating the last", async () => {
  const provider = fakeProvider([
    { message: { role: "assistant", content: [textBlock("one")] } },
    { message: { role: "assistant", content: [textBlock("two")] } },
  ]);
  const first = await collectDone(provider);
  const second = await collectDone(provider);
  const third = await collectDone(provider);
  expect([first, second, third]).toEqual(["one", "two", "two"]);
});

async function collectDone(provider: ReturnType<typeof fakeProvider>): Promise<string> {
  let text = "";
  for await (const c of provider.stream({ model: "fake", messages: [] })) {
    if (c.type === "message_done" && c.message.content[0]?.type === "text") text = c.message.content[0].text;
  }
  return text;
}
