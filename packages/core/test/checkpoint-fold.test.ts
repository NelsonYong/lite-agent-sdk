import { expect, test } from "vitest";
import { foldEvents } from "../src/checkpoint";
import type { SessionEvent } from "../src/checkpoint";
import { textBlock, toolResultBlock } from "../src/types";

test("foldEvents rebuilds messages and coalesces consecutive tool_result events", () => {
  const events: SessionEvent[] = [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "assistant", message: { role: "assistant", content: [textBlock("ok")] } },
    { type: "tool_result", result: toolResultBlock("a", "ra"), turn: 1 },
    { type: "tool_result", result: toolResultBlock("b", "rb"), turn: 1 },
    { type: "assistant", message: { role: "assistant", content: [textBlock("done")] } },
  ];
  expect(foldEvents(events)).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: [textBlock("ok")] },
    { role: "user", content: [toolResultBlock("a", "ra"), toolResultBlock("b", "rb")] },
    { role: "assistant", content: [textBlock("done")] },
  ]);
});

test("foldEvents flushes a trailing tool_result group", () => {
  const events: SessionEvent[] = [
    { type: "assistant", message: { role: "assistant", content: [textBlock("x")] } },
    { type: "tool_result", result: toolResultBlock("c", "rc"), turn: 1 },
  ];
  expect(foldEvents(events)).toEqual([
    { role: "assistant", content: [textBlock("x")] },
    { role: "user", content: [toolResultBlock("c", "rc")] },
  ]);
});

test("foldEvents on an empty log is an empty array", () => {
  expect(foldEvents([])).toEqual([]);
});

test("foldEvents skips file_snapshot sidecar events", () => {
  const events: SessionEvent[] = [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "file_snapshot", path: "a.txt", before: null, turn: 1 },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ];
  expect(foldEvents(events)).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
});
