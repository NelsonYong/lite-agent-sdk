import { expect, test } from "vitest";
import { microPass } from "../src/compaction/micro";
import type { Message } from "../src/types";

const tr = (id: string, content: string, isError = false): Message =>
  ({ role: "user", content: [{ type: "tool_result", id, content, ...(isError ? { isError: true } : {}) }] });

const asst = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });

test("microPass replaces older tool_result bodies with a placeholder, keeping the most recent N", () => {
  const msgs: Message[] = [tr("a", "AAA"), tr("b", "BBB"), tr("c", "CCC"), tr("d", "DDD")];
  const out = microPass({ keepRecent: 2, placeholder: "[omitted]" }).apply(msgs);
  const body = (m: Message, i = 0) => (m.content as any)[i].content;
  expect(body(out[0]!)).toBe("[omitted]");
  expect(body(out[1]!)).toBe("[omitted]");
  expect(body(out[2]!)).toBe("CCC"); // recent kept
  expect(body(out[3]!)).toBe("DDD");
});

test("microPass returns the same array reference when nothing exceeds keepRecent", () => {
  const msgs: Message[] = [tr("a", "AAA"), tr("b", "BBB")];
  const out = microPass({ keepRecent: 3 }).apply(msgs);
  expect(out).toBe(msgs);
});

test("microPass preserves the tool_result block's id and isError", () => {
  const msgs: Message[] = [tr("x", "big", true), tr("y", "k1"), tr("z", "k2"), tr("w", "k3")];
  const block = (microPass({ keepRecent: 3 }).apply(msgs)[0]!.content as any)[0];
  expect(block).toMatchObject({ type: "tool_result", id: "x", isError: true, content: "[tool result omitted to save context]" });
});

test("microPass does not touch text or tool_call blocks", () => {
  const msgs: Message[] = [
    { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "f", input: { a: 1 } }] },
    asst("hello"), tr("a", "1"), tr("b", "2"), tr("c", "3"), tr("d", "4"),
  ];
  const out = microPass({ keepRecent: 1 }).apply(msgs);
  expect(out[0]).toEqual(msgs[0]); // tool_call untouched
  expect(out[1]).toEqual(msgs[1]); // text untouched
});

test("microPass is idempotent — re-running keeps the same reference", () => {
  const once = microPass({ keepRecent: 1, placeholder: "[omitted]" }).apply([tr("a", "1"), tr("b", "2"), tr("c", "3")]);
  const twice = microPass({ keepRecent: 1, placeholder: "[omitted]" }).apply(once);
  expect(twice).toBe(once);
});
