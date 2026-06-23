import { expect, test } from "vitest";
import { defaultCompactor } from "../src/compaction/defaultCompactor";
import { compaction } from "../src/compaction/middleware";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { noopSandbox } from "../src/sandbox";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { textBlock } from "../src/types";
import type { Message } from "../src/types";
import type { Compactor } from "../src/strategies";
import type { AgentContext, Middleware } from "../src/middleware";
import type { AgentEvent, RunResult } from "../src/events";

const ZERO = { inputTokens: 0, outputTokens: 0 };
const tr = (id: string, content: string): Message => ({ role: "user", content: [{ type: "tool_result", id, content }] });
const turn = (u: string, id: string, r: string): Message[] => [
  { role: "user", content: u },
  { role: "assistant", content: [{ type: "tool_call", id, name: "f", input: {} }] },
  tr(id, r),
];

test("defaultCompactor pipelines snip + micro and reports a token reduction", async () => {
  const msgs = [0, 1, 2, 3, 4, 5].flatMap((i) => turn(`q${i}`, `c${i}`, `result-${i}-`.repeat(20)));
  const r = await defaultCompactor({ maxMessages: 6, headTurns: 1, tailKeep: 3, keepRecentToolResults: 1 }).maybeCompact(msgs, ZERO);
  expect(r.messages.length).toBeLessThan(msgs.length);
  expect(r.after!).toBeLessThan(r.before!);
  expect(r.kind).toBe("micro");
});

test("defaultCompactor is a no-op (same ref, equal before/after) when nothing to do", async () => {
  const msgs: Message[] = [{ role: "user", content: "hi" }];
  const r = await defaultCompactor().maybeCompact(msgs, ZERO);
  expect(r.messages).toBe(msgs);
  expect(r.after).toBe(r.before);
});

test("defaultCompactor accepts a custom passes pipeline (hot-swappable)", async () => {
  const msgs = [0, 1, 2, 3].flatMap((i) => turn(`q${i}`, `c${i}`, `r${i}`));
  const noop = { name: "noop", apply: (m: Message[]) => m };
  const r = await defaultCompactor({ passes: [noop] }).maybeCompact(msgs, ZERO);
  expect(r.messages).toBe(msgs);
});

function fakeCtx(messages: Message[], events: AgentEvent[]): AgentContext {
  return { sessionId: "s", messages, turn: 1, signal: new AbortController().signal, emit: (e) => events.push(e), state: new Map() };
}

test("compaction middleware swaps ctx.messages and emits when the compactor shrinks", async () => {
  const compactor: Compactor = {
    async maybeCompact() { return { messages: [{ role: "user", content: "[compacted]" }], kind: "micro", before: 100, after: 5 }; },
  };
  const events: AgentEvent[] = [];
  const ctx = fakeCtx([{ role: "user", content: "a" }, { role: "user", content: "b" }], events);
  await compaction(compactor).beforeModel!(ctx);
  expect(ctx.messages).toEqual([{ role: "user", content: "[compacted]" }]);
  expect(events).toContainEqual({ type: "compaction", kind: "micro", before: 100, after: 5 });
});

test("compaction middleware is a no-op (no event) when the compactor returns the same messages", async () => {
  const same: Message[] = [{ role: "user", content: "hi" }];
  const compactor: Compactor = { async maybeCompact(m) { return { messages: m, before: 5, after: 5 }; } };
  const events: AgentEvent[] = [];
  const ctx = fakeCtx(same, events);
  await compaction(compactor).beforeModel!(ctx);
  expect(ctx.messages).toBe(same);
  expect(events).toEqual([]);
});

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: fakeProvider([]), codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
}
async function drain(gen: AsyncGenerator<AgentEvent, RunResult>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}

test("compaction plugs into the kernel via use[] and emits on a real run", async () => {
  const echo = defineTool({ name: "f", description: "f", schema: (await import("zod")).z.object({}), execute: () => "r" });
  const shrink: Compactor = {
    async maybeCompact(messages) {
      if (messages.length <= 1) return { messages, before: 1, after: 1 };
      return { messages: [messages[0]!], kind: "micro", before: 10, after: 1 };
    },
  };
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "f", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const mw: Middleware = compaction(shrink);
  const { events } = await drain(runKernel(baseCfg({ provider, tools: [echo], middleware: [mw] }), "hi", new AbortController().signal, "s1"));
  expect(events.map((e) => e.type)).toContain("compaction");
});
