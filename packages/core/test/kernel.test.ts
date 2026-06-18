import { expect, test } from "vitest";
import { z } from "zod";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { textBlock } from "../src/types";
import type { AgentEvent, RunResult } from "../src/events";

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: fakeProvider([]), codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, ...over };
}

async function drain(gen: AsyncGenerator<AgentEvent, RunResult>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}

test("text-only response yields a clean stop sequence", async () => {
  const provider = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider }), "hello", new AbortController().signal, "s1"),
  );
  expect(events.map((e) => e.type)).toEqual([
    "turn_start", "text_delta", "text_delta", "message", "turn_end", "done",
  ]);
  expect(result.text).toBe("hi");
  expect(result.stopReason).toBe("stop");
});

test("a tool call is executed and fed back, then the model stops", async () => {
  const echo = defineTool({
    name: "echo", description: "echo", schema: z.object({ msg: z.string() }),
    execute: (i) => i.msg,
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "echo", input: { msg: "yo" } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider, tools: [echo] }), "hi", new AbortController().signal, "s1"),
  );
  expect(events.map((e) => e.type)).toEqual([
    "turn_start", "message", "tool_use", "tool_result", "turn_end",
    "turn_start", "text_delta", "text_delta", "text_delta", "text_delta", "message", "turn_end", "done",
  ]);
  const toolResult = events.find((e) => e.type === "tool_result");
  expect(toolResult).toMatchObject({ type: "tool_result", result: { name: "echo", content: "yo" } });
});

test("an unknown tool returns an error result instead of throwing", async () => {
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "missing", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider }), "hi", new AbortController().signal, "s1"),
  );
  const tr = events.find((e) => e.type === "tool_result");
  expect(tr).toMatchObject({ result: { isError: true } });
});

test("an aborted signal ends the run with reason 'aborted'", async () => {
  const ac = new AbortController();
  ac.abort();
  const provider = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  const { events, result } = await drain(runKernel(baseCfg({ provider }), "hi", ac.signal, "s1"));
  expect(result.stopReason).toBe("aborted");
  expect(events.at(-1)).toMatchObject({ type: "done", reason: "aborted" });
});
