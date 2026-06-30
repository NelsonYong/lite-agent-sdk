import { expect, test } from "vitest";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { noopSandbox } from "../src/sandbox";
import { memoryCheckpointer, foldEvents } from "../src/checkpoint";
import { defineTool } from "../src/tools/define";
import { fakeProvider } from "../src/testing/fakeProvider";
import { textBlock } from "../src/types";
import { z } from "zod";
import type { ModelProvider } from "../src/strategies";
import type { AgentEvent, RunResult } from "../src/events";

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: { id: "x", async *stream() {} }, codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
}
const run = async (gen: AsyncGenerator<AgentEvent, RunResult>) => { let r = await gen.next(); while (!r.done) r = await gen.next(); return r.value; };
const echo = defineTool({ name: "echo", description: "echo", schema: z.object({ v: z.string() }), execute: async ({ v }) => v });

test("a run appends user, assistant, and one tool_result event per call", async () => {
  const cp = memoryCheckpointer();
  let i = 0;
  const fp: ModelProvider = {
    id: "fp",
    async *stream() {
      const turn = i++;
      if (turn === 0) {
        yield { type: "message_done", message: { role: "assistant", content: [
          { type: "tool_call", id: "t1", name: "echo", input: { v: "A" } },
          { type: "tool_call", id: "t2", name: "echo", input: { v: "B" } },
        ] }, usage: { inputTokens: 0, outputTokens: 0 } };
      } else {
        yield { type: "message_done", message: { role: "assistant", content: [textBlock("done")] }, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    },
  };
  await run(runKernel(baseCfg({ provider: fp, tools: [echo], checkpointer: cp }), "hi", new AbortController().signal, "s"));
  const types: string[] = [];
  for await (const e of cp.read("s")) types.push(e.event.type);
  // user(hi), assistant(2 tool_calls), tool_result x2, assistant(done)
  expect(types).toEqual(["user", "assistant", "tool_result", "tool_result", "assistant"]);
});

test("resume replays the log so the model sees prior context", async () => {
  const cp = memoryCheckpointer();
  const seen: string[] = [];
  const recorder: ModelProvider = {
    id: "rec",
    async *stream(req) {
      seen.push(JSON.stringify(req.messages));
      yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  await run(runKernel(baseCfg({ provider: recorder, checkpointer: cp }), "first", new AbortController().signal, "s"));
  await run(runKernel(baseCfg({ provider: recorder, checkpointer: cp }), "second", new AbortController().signal, "s"));
  // the second run's request includes the first turn's user+assistant
  expect(seen[1]).toContain("first");
  expect(seen[1]).toContain("ok");
  expect(seen[1]).toContain("second");
  // and the persisted log folds to the full conversation
  const events = [];
  for await (const e of cp.read("s")) events.push(e.event);
  expect(foldEvents(events).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
});

test("a tool's recordSnapshot persists a file_snapshot before its tool_result", async () => {
  const cp = memoryCheckpointer();
  const snap = defineTool({
    name: "snap", description: "s", schema: z.object({}),
    execute: (_i, ctx) => { ctx.recordSnapshot?.("f.txt", "OLD"); return "done"; },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "snap", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  await run(runKernel(baseCfg({ provider, tools: [snap], checkpointer: cp }), "hi", new AbortController().signal, "s1"));
  const types: string[] = [];
  for await (const e of cp.read("s1")) types.push(e.event.type);
  const iSnap = types.indexOf("file_snapshot");
  const iResult = types.indexOf("tool_result");
  expect(iSnap).toBeGreaterThanOrEqual(0);
  expect(iSnap).toBeLessThan(iResult);
});
