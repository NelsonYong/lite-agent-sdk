import { expect, test } from "vitest";
import { nativeCodec } from "../src/codecs/native";
import { textBlock } from "../src/types";
import type { AssistantMessage, ModelRequest, ToolSpec } from "../src/types";

const codec = nativeCodec();

test("encode attaches tool specs when present, leaves request alone when empty", () => {
  const req: ModelRequest = { model: "m", messages: [] };
  const specs: ToolSpec[] = [{ name: "echo", description: "d", parameters: { type: "object" } }];
  expect(codec.encode(req, specs).tools).toEqual(specs);
  expect(codec.encode(req, []).tools).toBeUndefined();
});

test("decode splits text from tool_call blocks", () => {
  const msg: AssistantMessage = {
    role: "assistant",
    content: [textBlock("thinking "), { type: "tool_call", id: "t1", name: "echo", input: { msg: "yo" } }],
  };
  const { text, calls } = codec.decode(msg);
  expect(text).toBe("thinking ");
  expect(calls).toEqual([{ id: "t1", name: "echo", input: { msg: "yo" } }]);
});
