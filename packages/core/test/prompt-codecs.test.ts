import { expect, test } from "vitest";
import { jsonCodec } from "../src/codecs/json";
import { reactCodec } from "../src/codecs/react";
import { CodecError } from "../src/events";
import { runKernel } from "../src/kernel";
import { fakeProvider } from "../src/testing/fakeProvider";
import { noopSandbox } from "../src/sandbox";
import type { AssistantMessage, ModelRequest, ToolSpec } from "../src/types";

const tools: ToolSpec[] = [{ name: "echo", description: "echo", parameters: { type: "object" } }];
const req: ModelRequest = {
  model: "local",
  system: "base",
  tools,
  toolChoice: "auto",
  messages: [
    { role: "assistant", content: [{ type: "tool_call", id: "old", name: "echo", input: { v: 1 } }] },
    { role: "user", content: [{ type: "tool_result", id: "old", content: "one" }] },
  ],
};
const message = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }] });

test("jsonCodec uses a plain-text protocol and decodes final answers", () => {
  const codec = jsonCodec();
  const encoded = codec.encode(req, tools);
  expect(encoded.tools).toBeUndefined();
  expect(encoded.toolChoice).toBeUndefined();
  expect(encoded.system).toContain('"type":"tool_calls"');
  expect(encoded.messages[0]!.content).toContain('"name":"echo"');
  expect(encoded.messages[1]!.content).toContain('"type":"tool_results"');
  expect(codec.decode(message('{"type":"final","text":"done"}'))).toEqual({ text: "done", calls: [] });
});

test("jsonCodec accepts fenced aliases and creates deterministic call ids", () => {
  const codec = jsonCodec();
  const raw = '```json\n{"tool":"echo","arguments":"{\\"v\\":2}"}\n```';
  const first = codec.decode(message(raw));
  const second = codec.decode(message(raw));
  expect(first.calls).toEqual(second.calls);
  expect(first.calls[0]).toMatchObject({ name: "echo", input: { v: 2 } });
  expect(first.calls[0]!.id).toMatch(/^call_[a-f0-9]{16}$/);
});

test("jsonCodec fails declared malformed tool calls", () => {
  expect(() => jsonCodec().decode(message('{"type":"tool_calls","calls":[]}'))).toThrow(CodecError);
  expect(() => jsonCodec().decode(message('{"tool":"echo","arguments":"{"}'))).toThrow(CodecError);
});

test("reactCodec decodes action and final forms", () => {
  const codec = reactCodec();
  expect(codec.decode(message("Action: echo\nAction Input: {\"v\":3}"))).toMatchObject({
    text: "", calls: [{ name: "echo", input: { v: 3 } }],
  });
  expect(codec.decode(message("Final Answer: complete"))).toEqual({ text: "complete", calls: [] });
  expect(() => codec.decode(message("Action: echo"))).toThrow(CodecError);
});

test("kernel buffers prompt protocol text and repairs malformed JSON in the same turn", async () => {
  const provider = fakeProvider([
    { text: "bad", message: message('{"type":"tool_calls","calls":[]}') },
    { text: "ok", message: message('{"type":"final","text":"fixed"}') },
  ]);
  const gen = runKernel({
    provider, codec: jsonCodec(), tools: [], middleware: [], model: "local",
    maxTurns: 1, maxDecodeRetries: 1, sandbox: noopSandbox(),
  }, "go", new AbortController().signal, "s");
  const events = [];
  let result = await gen.next();
  while (!result.done) { events.push(result.value); result = await gen.next(); }
  expect(events.filter((event) => event.type === "error")).toEqual([
    expect.objectContaining({ type: "error", fatal: false }),
  ]);
  expect(events.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "fixed" }]);
  expect(result.value.text).toBe("fixed");
});
