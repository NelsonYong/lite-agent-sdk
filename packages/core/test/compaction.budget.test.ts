import { expect, test } from "vitest";
import { memorySpillStore, toolResultBudgetPass } from "../src/compaction/budget";
import { microPass } from "../src/compaction/micro";
import { defaultCompactor } from "../src/compaction/defaultCompactor";
import type { Message } from "../src/types";

const ZERO = { inputTokens: 0, outputTokens: 0 };
const tr = (id: string, content: string): Message => ({ role: "user", content: [{ type: "tool_result", id, content }] });
const body = (m: Message): string => (m.content as any)[0].content;

test("memorySpillStore round-trips content by ref", () => {
  const s = memorySpillStore();
  const ref = s.put("hello");
  expect(s.get(ref)).toBe("hello");
  expect(s.get("nope")).toBeNull();
});

test("toolResultBudgetPass spills the largest tool_results over budget and keeps them retrievable", async () => {
  const store = memorySpillStore();
  const msgs = [tr("a", "x".repeat(100)), tr("b", "y".repeat(10)), tr("c", "z".repeat(100))];
  const out = (await toolResultBudgetPass({ store, budgetBytes: 50 }).apply(msgs));
  expect(body(out[0]!)).toMatch(/^\[spilled:/);
  expect(body(out[2]!)).toMatch(/^\[spilled:/);
  expect(body(out[1]!)).toBe("y".repeat(10)); // small one kept verbatim
  const ref = body(out[0]!).match(/\[spilled:([^\]]+)\]/)![1]!;
  expect(store.get(ref)).toBe("x".repeat(100)); // full content retrievable
  expect((out[0]!.content as any)[0]).toMatchObject({ type: "tool_result", id: "a" }); // block structure preserved
});

test("toolResultBudgetPass returns the same reference when under budget", async () => {
  const store = memorySpillStore();
  const msgs = [tr("a", "small")];
  expect((await toolResultBudgetPass({ store, budgetBytes: 1000 }).apply(msgs))).toBe(msgs);
});

test("microPass leaves spilled markers intact (does not clobber the ref)", async () => {
  const store = memorySpillStore();
  const msgs = [tr("a", "x".repeat(100)), tr("b", "y".repeat(100)), tr("c", "z"), tr("d", "w")];
  const spilled = (await toolResultBudgetPass({ store, budgetBytes: 50 }).apply(msgs));
  const out = (await microPass({ keepRecent: 0, placeholder: "[MICRO]" }).apply(spilled));
  expect(body(out[0]!)).toMatch(/^\[spilled:/);
  expect(body(out[1]!)).toMatch(/^\[spilled:/);
});

test("defaultCompactor with a spillStore spills oversized tool results before snip/micro", async () => {
  const store = memorySpillStore();
  const msgs = [tr("a", "x".repeat(300_000))];
  const r = await defaultCompactor({ spillStore: store, budgetBytes: 200_000 }).maybeCompact(msgs, ZERO);
  expect(body(r.messages[0]!)).toMatch(/^\[spilled:/);
  const ref = body(r.messages[0]!).match(/\[spilled:([^\]]+)\]/)![1]!;
  expect(store.get(ref)).toBe("x".repeat(300_000));
});

test("async spill encoding completes before publishing references and rejects without changing input", async () => {
  const messages = [tr("a", "large".repeat(100))];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const pending = toolResultBudgetPass({ budgetBytes: 1, store: {
    async put() { await waiting; return "saved"; },
    get() { return null; },
  } }).apply(messages);
  expect(body(messages[0]!)).toBe("large".repeat(100));
  release();
  expect(body((await pending)[0]!)).toContain("[spilled:saved]");
  const failing = defaultCompactor({ budgetBytes: 1, spillStore: {
    async put() { throw new Error("storage unavailable"); }, get() { return null; },
  } });
  await expect(failing.maybeCompact(messages, ZERO)).rejects.toThrow("storage unavailable");
  expect(body(messages[0]!)).toBe("large".repeat(100));
});
