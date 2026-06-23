import { expect, test } from "vitest";
import { reactiveCompaction, reactiveTrim } from "../src/compaction/reactive";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { noopSandbox } from "../src/sandbox";
import { ProviderError } from "../src/events";
import { textBlock } from "../src/types";
import type { Message } from "../src/types";
import type { ModelProvider } from "../src/strategies";
import type { AgentEvent, RunResult } from "../src/events";

const ZERO = { inputTokens: 0, outputTokens: 0 };
const turn = (u: string, id: string, r: string): Message[] => [
  { role: "user", content: u },
  { role: "assistant", content: [{ type: "tool_call", id, name: "f", input: {} }] },
  { role: "user", content: [{ type: "tool_result", id, content: r }] },
];
function pairingOk(messages: Message[]): boolean {
  const seen = new Set<string>();
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === "tool_call") seen.add(b.id);
      for (const b of m.content) if (b.type === "tool_result" && !seen.has(b.id)) return false;
    }
  }
  return true;
}
function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: { id: "x", async *stream() {} }, codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
}
async function drain(gen: AsyncGenerator<AgentEvent, RunResult>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}
const sig = () => new AbortController().signal;

test("reactiveCompaction trims and retries on prompt_too_long, then succeeds", async () => {
  const seen: number[] = [];
  let calls = 0;
  const provider: ModelProvider = {
    id: "ov",
    async *stream(req) {
      calls++;
      seen.push(req.messages.length);
      if (calls === 1) throw new ProviderError("prompt is too long", 413);
      yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: ZERO };
    },
  };
  const input = [0, 1, 2, 3, 4, 5].flatMap((i) => turn(`q${i}`, `c${i}`, `r${i}`));
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, middleware: [reactiveCompaction()] }), input, sig(), "s1"),
  );
  expect(calls).toBe(2);
  expect(seen[1]!).toBeLessThan(seen[0]!); // retried with fewer messages
  expect(result.text).toBe("ok");
  expect(events.map((e) => e.type)).toContain("compaction");
});

test("reactiveCompaction passes through a non-overflow error", async () => {
  let calls = 0;
  const provider: ModelProvider = { id: "e", async *stream() { calls++; throw new ProviderError("boom", 500); } };
  await expect(drain(runKernel(baseCfg({ provider, middleware: [reactiveCompaction()] }), "hi", sig(), "s1"))).rejects.toThrow();
  expect(calls).toBe(1);
});

test("reactiveCompaction does not retry once chunks have streamed", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    id: "m",
    async *stream() { calls++; yield { type: "text_delta", text: "partial" }; throw new ProviderError("prompt too long", 413); },
  };
  await expect(drain(runKernel(baseCfg({ provider, middleware: [reactiveCompaction()] }), "hi", sig(), "s1"))).rejects.toThrow();
  expect(calls).toBe(1);
});

test("reactiveCompaction surfaces overflow after maxAttempts", async () => {
  let calls = 0;
  const provider: ModelProvider = { id: "a", async *stream() { calls++; throw new ProviderError("prompt too long", 413); } };
  const input = [0, 1, 2, 3].flatMap((i) => turn(`q${i}`, `c${i}`, `r${i}`));
  await expect(drain(runKernel(baseCfg({ provider, middleware: [reactiveCompaction({ maxAttempts: 2 })] }), input, sig(), "s1"))).rejects.toThrow();
  expect(calls).toBe(3); // 1 initial + 2 reactive attempts
});

test("reactiveTrim keeps the last turns, pairing-safe, prefixed with a placeholder", () => {
  const msgs = [0, 1, 2, 3, 4].flatMap((i) => turn(`q${i}`, `c${i}`, `r${i}`));
  const out = reactiveTrim(msgs, { keepTurns: 2, tokenBudget: 100000 });
  expect(out.length).toBeLessThan(msgs.length);
  expect(typeof out[0]!.content === "string" && /dropped/.test(out[0]!.content as string)).toBe(true);
  expect(pairingOk(out)).toBe(true);
});

test("reactiveTrim returns the same reference when nothing to drop", () => {
  const msgs = turn("only", "c0", "r0");
  expect(reactiveTrim(msgs, { keepTurns: 5 })).toBe(msgs);
});
