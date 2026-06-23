import { expect, test } from "vitest";
import { snipPass } from "../src/compaction/snip";
import type { Message } from "../src/types";

// one full turn: user prompt → assistant tool_call → user tool_result
const turn = (u: string, callId: string, result: string): Message[] => [
  { role: "user", content: u },
  { role: "assistant", content: [{ type: "tool_call", id: callId, name: "f", input: {} }] },
  { role: "user", content: [{ type: "tool_result", id: callId, content: result }] },
];

// every tool_result must have its tool_call appear earlier (provider invariant)
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

const sixTurns = (): Message[] =>
  [0, 1, 2, 3, 4, 5].flatMap((i) => turn(`q${i}`, `c${i}`, `r${i}`)); // 18 messages

test("snipPass drops the middle turns and keeps head + tail when over the message cap", () => {
  const out = snipPass({ maxMessages: 5, headTurns: 1, tailKeep: 3 }).apply(sixTurns());
  expect(out.length).toBeLessThan(18);
  expect(out[0]).toEqual({ role: "user", content: "q0" }); // head turn kept
  expect(out.some((m) => typeof m.content === "string" && /omitted/.test(m.content))).toBe(true);
  expect(out.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", id: "c5", content: "r5" }] }); // tail kept
});

test("snipPass never severs a tool_call from its tool_result", () => {
  const out = snipPass({ maxMessages: 5, headTurns: 1, tailKeep: 3 }).apply(sixTurns());
  expect(pairingOk(out)).toBe(true);
});

test("snipPass returns the same reference when at or under the cap", () => {
  const msgs = sixTurns();
  expect(snipPass({ maxMessages: 100 }).apply(msgs)).toBe(msgs);
});

test("snipPass returns the same reference when there is no middle to drop", () => {
  const msgs = turn("only", "c0", "r0"); // 3 messages, one turn
  expect(snipPass({ maxMessages: 1, headTurns: 1, tailKeep: 1 }).apply(msgs)).toBe(msgs);
});
