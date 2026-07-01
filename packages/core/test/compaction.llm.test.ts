import { expect, test } from "vitest";
import { llmCompactor } from "../src/compaction/llm";
import { defaultCompactor } from "../src/compaction/defaultCompactor";
import { textBlock } from "../src/types";
import type { Message } from "../src/types";
import type { ModelProvider } from "../src/strategies";

const ZERO = { inputTokens: 0, outputTokens: 0 };
const done = (t: string) => ({ type: "message_done" as const, message: { role: "assistant" as const, content: [textBlock(t)] }, usage: ZERO });
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

test("llmCompactor does not call the LLM when under the token threshold", async () => {
  let calls = 0;
  const provider: ModelProvider = { id: "s", async *stream() { calls++; yield done("X"); } };
  const r = await llmCompactor({ provider, model: "m", tokenThreshold: 1_000_000 }).maybeCompact([{ role: "user", content: "hi" }], ZERO);
  expect(calls).toBe(0);
  expect(r.messages).toEqual([{ role: "user", content: "hi" }]);
});

test("llmCompactor summarizes older turns via the LLM when over threshold", async () => {
  const big = (i: number) => `result-${i}-`.repeat(50); // realistic: large tool outputs
  const provider: ModelProvider = { id: "s", async *stream() { yield done("CONDENSED"); } };
  const c = llmCompactor({ provider, model: "m", tokenThreshold: 10, keepRecentTurns: 1, base: defaultCompactor({ maxMessages: 1000 }) });
  const msgs = [0, 1, 2, 3, 4].flatMap((i) => turn(`q${i}`, `c${i}`, big(i)));
  const r = await c.maybeCompact(msgs, ZERO);
  expect(r.kind).toBe("auto");
  expect(r.messages.length).toBeLessThan(msgs.length);
  expect(typeof r.messages[0]!.content === "string" && /CONDENSED/.test(r.messages[0]!.content as string)).toBe(true);
  expect(r.messages.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", id: "c4", content: big(4) }] }); // recent turn verbatim
  expect(pairingOk(r.messages)).toBe(true);
  expect(r.after!).toBeLessThan(r.before!);
});

test("llmCompactor leaves it to the base when there are too few turns to summarize", async () => {
  let calls = 0;
  const provider: ModelProvider = { id: "s", async *stream() { calls++; yield done("X"); } };
  const c = llmCompactor({ provider, model: "m", tokenThreshold: 1, keepRecentTurns: 3, base: defaultCompactor({ maxMessages: 1000 }) });
  const msgs = [0, 1].flatMap((i) => turn(`q${i}`, `c${i}`, `r${i}`)); // 2 turns ≤ keepRecent+1
  await c.maybeCompact(msgs, ZERO);
  expect(calls).toBe(0);
});

test("llmCompactor appends custom instructions to the summary prompt (append, not override)", async () => {
  let seenSystem: string | undefined;
  const provider: ModelProvider = { id: "s", async *stream(req) { seenSystem = req.system; yield done("CONDENSED"); } };
  const c = llmCompactor({ provider, model: "m", tokenThreshold: 10, keepRecentTurns: 1, base: defaultCompactor({ maxMessages: 1000 }) });
  const big = (i: number) => `result-${i}-`.repeat(50);
  const msgs = [0, 1, 2, 3, 4].flatMap((i) => turn(`q${i}`, `c${i}`, big(i)));
  await c.maybeCompact(msgs, ZERO, "Preserve every API endpoint name verbatim.");
  expect(seenSystem).toContain("Preserve every API endpoint name verbatim."); // user's instruction is honored
  expect(seenSystem).toContain("context-compaction assistant"); // ...appended to the default prompt, not replacing it
});

test("llmCompactor opens a circuit breaker after repeated LLM failures", async () => {
  let calls = 0;
  const provider: ModelProvider = { id: "f", async *stream() { calls++; throw new Error("llm down"); } };
  const c = llmCompactor({ provider, model: "m", tokenThreshold: 1, keepRecentTurns: 1, maxFailures: 2, base: defaultCompactor({ maxMessages: 1000 }) });
  const msgs = [0, 1, 2].flatMap((i) => turn(`q${i}`, `c${i}`, `r${i}`));
  const r1 = await c.maybeCompact(msgs, ZERO); // fail 1 → graceful base fallback
  await c.maybeCompact(msgs, ZERO);            // fail 2 → circuit opens
  await c.maybeCompact(msgs, ZERO);            // circuit open → no LLM call
  expect(calls).toBe(2);
  expect(r1.messages.length).toBe(msgs.length); // fell back to base (no summary)
});
