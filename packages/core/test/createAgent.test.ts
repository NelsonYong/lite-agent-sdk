import { expect, test } from "vitest";
import { z } from "zod";
import { createAgent } from "../src/createAgent";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { memoryStore } from "../src/store";
import { textBlock } from "../src/types";

test("send() runs the loop and returns the final result", async () => {
  const agent = createAgent({
    model: fakeProvider([{ text: "hello world", message: { role: "assistant", content: [textBlock("hello world")] } }]),
    codec: nativeCodec(),
  });
  const result = await agent.send("hi");
  expect(result.text).toBe("hello world");
  expect(result.stopReason).toBe("stop");
});

test("run() streams events for a tool-using turn via configured tools", async () => {
  const add = defineTool({
    name: "add", description: "add two numbers",
    schema: z.object({ a: z.number(), b: z.number() }),
    execute: (i) => String(i.a + i.b),
  });
  const agent = createAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "add", input: { a: 2, b: 3 } }] } },
      { text: "5", message: { role: "assistant", content: [textBlock("5")] } },
    ]),
    codec: nativeCodec(),
    tools: [add],
  });
  const types: string[] = [];
  for await (const ev of agent.run("2+3?")) types.push(ev.type);
  expect(types).toContain("tool_use");
  expect(types).toContain("tool_result");
  expect(types.at(-1)).toBe("done");
});

test("createAgent resumes a session across separate runs via its store", async () => {
  const store = memoryStore();
  const cfg = (text: string) => ({
    model: fakeProvider([{ text, message: { role: "assistant" as const, content: [textBlock(text)] } }]),
    codec: nativeCodec(),
    store,
  });
  await createAgent(cfg("one")).send("first", { sessionId: "x" });
  const r2 = await createAgent(cfg("two")).send("second", { sessionId: "x" });
  // the second run resumed the first run's persisted transcript
  expect(r2.messages).toContainEqual({ role: "user", content: "first" });
  expect(r2.messages).toContainEqual({ role: "user", content: "second" });
  expect(r2.text).toBe("two");
});

test("a user middleware observes via beforeAgent", async () => {
  const seen: string[] = [];
  const agent = createAgent({
    model: fakeProvider([{ text: "x", message: { role: "assistant", content: [textBlock("x")] } }]),
    codec: nativeCodec(),
    use: [{ name: "spy", beforeAgent: () => { seen.push("before"); } }],
  });
  await agent.send("hi");
  expect(seen).toEqual(["before"]);
});
