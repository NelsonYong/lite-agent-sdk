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
import { memoryStore } from "../src/store";
import type { Store } from "../src/strategies";

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

test("kernel resumes saved history from the store ahead of the new input", async () => {
  const store = memoryStore();
  await store.save("s1", [
    { role: "user", content: "earlier" },
    { role: "assistant", content: [textBlock("ok")] },
  ]);
  const provider = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  const { result } = await drain(
    runKernel(baseCfg({ provider, store }), "next", new AbortController().signal, "s1"),
  );
  expect(result.messages[0]).toEqual({ role: "user", content: "earlier" });
  expect(result.messages).toContainEqual({ role: "user", content: "next" });
});

test("kernel saves the transcript to the store after the run", async () => {
  const store = memoryStore();
  const provider = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  await drain(runKernel(baseCfg({ provider, store }), "hello", new AbortController().signal, "s1"));
  const saved = await store.load("s1");
  expect(saved).not.toBeNull();
  expect(saved).toContainEqual({ role: "user", content: "hello" });
  expect(saved!.some((m) => m.role === "assistant")).toBe(true);
});

test("kernel persists after each turn so an interrupted run is recoverable", async () => {
  const base = memoryStore();
  let saves = 0;
  const store: Store = { load: base.load, save: async (id, m) => { saves++; return base.save(id, m); } };
  const echo = defineTool({ name: "echo", description: "e", schema: z.object({}), execute: () => "r" });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "echo", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  await drain(runKernel(baseCfg({ provider, tools: [echo], store }), "hi", new AbortController().signal, "s1"));
  // two turns → saved at least twice; mid-run progress is durable, not end-only
  expect(saves).toBeGreaterThanOrEqual(2);
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

test("tool_result events and result blocks stay in input order regardless of completion order", async () => {
  const fast = defineTool({ name: "fast", description: "f", schema: z.object({}), execute: async () => "FAST" });
  const slow = defineTool({
    name: "slow", description: "s", schema: z.object({}),
    execute: async () => { await new Promise((r) => setTimeout(r, 30)); return "SLOW"; },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [
      { type: "tool_call", id: "t1", name: "slow", input: {} }, // input order: slow first
      { type: "tool_call", id: "t2", name: "fast", input: {} }, // but fast finishes first
    ] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [slow, fast] }), "hi", new AbortController().signal, "s1"),
  );
  const contents = events
    .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
    .map((e) => e.result.content);
  expect(contents).toEqual(["SLOW", "FAST"]);
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
  expect(results.map((r) => r.id)).toEqual(["t1", "t2"]); // both ran, in input order
  expect(results[0]).toMatchObject({ content: "OK" });    // sibling unaffected by the throw
  expect(results[1]).toMatchObject({ isError: true });    // throw → error result
  expect(results[1]!.content).toContain("kaboom");
  expect(result.stopReason).toBe("stop");                 // run completed cleanly, no rejection
});

test("each call's emitted events flush in input order, grouped with its result", async () => {
  // slow is input-index 0 but finishes LAST; fast is index 1 but finishes first.
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
  // Keep only each call's emitted request and its result, in stream order.
  const rel = events.filter((e) => e.type === "input_request" || e.type === "tool_result");
  // slow (index 0) flushes entirely BEFORE fast (index 1) despite fast finishing first:
  expect(rel.map((e) => e.type)).toEqual(["input_request", "tool_result", "input_request", "tool_result"]);
  const ids = rel.map((e) =>
    e.type === "tool_result" ? e.result.id : (e as Extract<AgentEvent, { type: "input_request" }>).call.id,
  );
  expect(ids).toEqual(["t1", "t1", "t2", "t2"]);
});
