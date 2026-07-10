import { expect, test, vi } from "vitest";
import { z } from "zod";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { textBlock } from "../src/types";
import type { AgentEvent, RunResult } from "../src/events";
import type { Middleware } from "../src/middleware";
import type { Message, ToolResultBlock } from "../src/types";
import type { ModelProvider } from "../src/strategies";
import { noopSandbox } from "../src/sandbox";
import { memoryCheckpointer, foldEvents } from "../src/checkpoint";
import type { Checkpointer } from "../src/checkpoint";

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: fakeProvider([]), codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
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
    "turn_start", "model_call_start", "text_delta", "text_delta", "model_call_end",
    "message", "turn_end", "done",
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
    "turn_start", "model_call_start", "model_call_end", "message", "tool_use",
    "tool_call_start", "tool_call_end", "tool_result", "turn_end",
    "turn_start", "model_call_start", "text_delta", "text_delta", "text_delta", "text_delta",
    "model_call_end", "message", "turn_end", "done",
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

test("events emitted by wrapModelCall middleware drain before the message event", async () => {
  const provider = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  const emitter: Middleware = {
    name: "emitter",
    async *wrapModelCall(ctx, next) {
      ctx.emit({ type: "compaction", kind: "micro", before: 1, after: 1 });
      yield* next();
    },
  };
  const { events } = await drain(
    runKernel(baseCfg({ provider, middleware: [emitter] }), "hi", new AbortController().signal, "s1"),
  );
  const types = events.map((e) => e.type);
  expect(types).toContain("compaction");
  expect(types.indexOf("compaction")).toBeLessThan(types.indexOf("message"));
});

test("a beforeModel middleware reassigning ctx.messages persists across turns", async () => {
  const echo = defineTool({ name: "echo", description: "e", schema: z.object({}), execute: () => "r" });
  const seen: Message[][] = [];
  const recorder: ModelProvider = {
    id: "rec",
    async *stream(req) {
      seen.push(structuredClone(req.messages));
      if (seen.length === 1) {
        yield { type: "message_done", message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "echo", input: {} }] }, usage: { inputTokens: 0, outputTokens: 0 } };
      } else {
        yield { type: "message_done", message: { role: "assistant", content: [textBlock("done")] }, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    },
  };
  const compactor: Middleware = {
    name: "compactor",
    beforeModel(ctx) { if (ctx.turn === 2) ctx.messages = [{ role: "user", content: "[COMPACTED]" }]; },
  };
  const events: AgentEvent[] = [];
  const gen = runKernel(
    { provider: recorder, codec: nativeCodec(), tools: [echo], middleware: [compactor], model: "rec", maxTurns: 10, sandbox: noopSandbox() },
    "hi", new AbortController().signal, "s1",
  );
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  const result = r.value;

  // turn 2's request used the compacted history
  expect(seen[1]).toEqual([{ role: "user", content: "[COMPACTED]" }]);
  // the compaction must persist into the final result (lost without the fix)
  expect(result.messages).toContainEqual({ role: "user", content: "[COMPACTED]" });
  expect(result.text).toBe("done");
});

test("kernel resumes saved history from the checkpointer ahead of the new input", async () => {
  const cp = memoryCheckpointer();
  await cp.append("s1", [
    { type: "user", message: { role: "user", content: "earlier" } },
    { type: "assistant", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  const provider = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  const { result } = await drain(
    runKernel(baseCfg({ provider, checkpointer: cp }), "next", new AbortController().signal, "s1"),
  );
  expect(result.messages[0]).toEqual({ role: "user", content: "earlier" });
  expect(result.messages).toContainEqual({ role: "user", content: "next" });
});

test("kernel persists the transcript to the checkpointer after the run", async () => {
  const cp = memoryCheckpointer();
  const provider = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  await drain(runKernel(baseCfg({ provider, checkpointer: cp }), "hello", new AbortController().signal, "s1"));
  const events = [];
  for await (const e of cp.read("s1")) events.push(e.event);
  const folded = foldEvents(events);
  expect(folded).toContainEqual({ role: "user", content: "hello" });
  expect(folded.some((m) => m.role === "assistant")).toBe(true);
});

test("kernel appends each event so an interrupted run is recoverable", async () => {
  const cp = memoryCheckpointer();
  let appends = 0;
  const counting: Checkpointer = {
    ...cp,
    append: (id, evs, expected) => { appends++; return cp.append(id, evs, expected); },
  };
  const echo = defineTool({ name: "echo", description: "e", schema: z.object({}), execute: () => "r" });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "echo", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  await drain(runKernel(baseCfg({ provider, tools: [echo], checkpointer: counting }), "hi", new AbortController().signal, "s1"));
  // user + assistant(turn1) + tool_result + assistant(turn2): per-event durability, not end-only
  expect(appends).toBeGreaterThanOrEqual(3);
  const types = [];
  for await (const e of cp.read("s1")) types.push(e.event.type);
  expect(types).toContain("tool_result");
});

test("the base model call re-encodes from current ctx.messages on each attempt", async () => {
  const seen: Message[][] = [];
  const provider: ModelProvider = {
    id: "rec",
    async *stream(req) {
      seen.push(structuredClone(req.messages));
      if (seen.length === 1) throw new Error("overflow");
      yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const shrinkRetry: Middleware = {
    name: "shrink-retry",
    async *wrapModelCall(ctx, next) {
      try { yield* next(); }
      catch { ctx.messages = [{ role: "user", content: "[small]" }]; yield* next(); }
    },
  };
  const { result } = await drain(
    runKernel(baseCfg({ provider, middleware: [shrinkRetry] }), "original-long", new AbortController().signal, "s1"),
  );
  expect(seen[0]).toEqual([{ role: "user", content: "original-long" }]);
  expect(seen[1]).toEqual([{ role: "user", content: "[small]" }]); // re-encoded from the mutated messages
  expect(result.text).toBe("ok");
});

test("kernel threads input + call into the tool execute context", async () => {
  const asker = { request: vi.fn(async () => ({ text: "blue" })) };
  const ask = defineTool({
    name: "ask", description: "ask", schema: z.object({}),
    execute: async (_i, ctx) => {
      ctx.emit({ type: "input_request", call: ctx.call!, question: { question: "color?" } });
      const ans = await ctx.input!.request({ question: "color?" });
      ctx.emit({ type: "input_resolved", id: ctx.call!.id, answer: ans });
      return ans.text ?? "";
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "ask", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider, tools: [ask], input: asker }), "hi", new AbortController().signal, "s1"),
  );
  expect(asker.request).toHaveBeenCalledTimes(1);
  const types = events.map((e) => e.type);
  expect(types).toContain("input_request");
  expect(types).toContain("input_resolved");
  expect(events.find((e) => e.type === "tool_result")).toMatchObject({ result: { id: "t1", content: "blue" } });
});

test("multiple tool calls in one turn run concurrently", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (name: string) =>
    defineTool({
      name, description: name, schema: z.object({}),
      execute: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return name;
      },
    });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "a", input: {} },
      { type: "tool_call", id: "t2", name: "b", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  await drain(
    runKernel(baseCfg({ provider, tools: [slow("a"), slow("b")] }), "hi", new AbortController().signal, "s1"),
  );
  expect(maxInFlight).toBe(2);
});

test("tool_result EVENTS stream in completion order; the model message stays input-ordered", async () => {
  const fast = defineTool({ name: "fast", description: "f", schema: z.object({}), execute: async () => "FAST" });
  const slow = defineTool({
    name: "slow", description: "s", schema: z.object({}),
    execute: async () => { await new Promise((r) => setTimeout(r, 30)); return "SLOW"; },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "slow", input: {} },
      { type: "tool_call", id: "t2", name: "fast", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [slow, fast] }), "hi", new AbortController().signal, "s1"),
  );
  // EVENT stream: completion order — fast emits its tool_result before slow.
  const contents = events
    .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
    .map((e) => e.result.content);
  expect(contents).toEqual(["FAST", "SLOW"]);
  // MODEL message: still input order (t1=slow, t2=fast), independent of completion timing.
  const userMsg = result.messages.find(
    (m) => m.role === "user" && Array.isArray(m.content) && (m.content as ToolResultBlock[]).every((b) => b.type === "tool_result"),
  );
  expect((userMsg!.content as ToolResultBlock[]).map((b) => b.id)).toEqual(["t1", "t2"]);
  expect((userMsg!.content as ToolResultBlock[]).map((b) => b.content)).toEqual(["SLOW", "FAST"]);
});

test("maxParallelTools: 1 forces sequential execution", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = (name: string) =>
    defineTool({
      name, description: name, schema: z.object({}),
      execute: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return name;
      },
    });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "a", input: {} },
      { type: "tool_call", id: "t2", name: "b", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  await drain(
    runKernel(baseCfg({ provider, tools: [slow("a"), slow("b")], maxParallelTools: 1 }), "hi", new AbortController().signal, "s1"),
  );
  expect(maxInFlight).toBe(1);
});

test("a wrapToolCall middleware that throws yields an error result without stranding siblings", async () => {
  const ok = defineTool({ name: "ok", description: "o", schema: z.object({}), execute: async () => "OK" });
  const boom = defineTool({ name: "boom", description: "b", schema: z.object({}), execute: async () => "NEVER" });
  const boomMw: Middleware = {
    name: "boom-mw",
    async wrapToolCall(ctx, next) {
      if (ctx.call.name === "boom") throw new Error("kaboom");
      return next();
    },
  };
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "ok", input: {} },
      { type: "tool_call", id: "t2", name: "boom", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [ok, boom], middleware: [boomMw] }), "hi", new AbortController().signal, "s1"),
  );
  const results = events
    .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
    .map((e) => e.result);
  // both siblings produced a result; events are completion-ordered, so look up by id:
  expect(results.map((r) => r.id).sort()).toEqual(["t1", "t2"]);
  const okRes = results.find((r) => r.id === "t1")!;
  const boomRes = results.find((r) => r.id === "t2")!;
  expect(okRes).toMatchObject({ content: "OK" });         // sibling unaffected by the throw
  expect(boomRes).toMatchObject({ isError: true });       // throw → error result
  expect(boomRes.content).toContain("kaboom");
  expect(result.stopReason).toBe("stop");                 // run completed cleanly, no rejection
});

test("a call's emitted events interleave live in completion order, each grouped with its own result", async () => {
  const slow = defineTool({
    name: "slow", description: "s", schema: z.object({}),
    execute: async (_i, ctx) => {
      ctx.emit({ type: "input_request", call: ctx.call!, question: { question: "slow?" } });
      await new Promise((r) => setTimeout(r, 30));
      return "SLOW";
    },
  });
  const fast = defineTool({
    name: "fast", description: "f", schema: z.object({}),
    execute: async (_i, ctx) => {
      ctx.emit({ type: "input_request", call: ctx.call!, question: { question: "fast?" } });
      return "FAST";
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "slow", input: {} },
      { type: "tool_call", id: "t2", name: "fast", input: {} },
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider, tools: [slow, fast] }), "hi", new AbortController().signal, "s1"),
  );
  const rel = events.filter((e) => e.type === "input_request" || e.type === "tool_result");
  // fast finishes first → its result precedes slow's result (completion order):
  const fastResultIdx = rel.findIndex((e) => e.type === "tool_result" && e.result.id === "t2");
  const slowResultIdx = rel.findIndex((e) => e.type === "tool_result" && e.result.id === "t1");
  expect(fastResultIdx).toBeLessThan(slowResultIdx);
  // each call's own input_request precedes its own tool_result:
  const idOf = (e: AgentEvent) => e.type === "tool_result" ? e.result.id : (e as Extract<AgentEvent, { type: "input_request" }>).call.id;
  const firstReq = (id: string) => rel.findIndex((e) => e.type === "input_request" && idOf(e) === id);
  const res = (id: string) => rel.findIndex((e) => e.type === "tool_result" && idOf(e) === id);
  expect(firstReq("t2")).toBeLessThan(res("t2"));
  expect(firstReq("t1")).toBeLessThan(res("t1"));
});
