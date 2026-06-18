import { expect, test } from "vitest";
import { textBlock, toolResultBlock, isToolCallBlock } from "../src/types";

test("textBlock builds a text content block", () => {
  expect(textBlock("hi")).toEqual({ type: "text", text: "hi" });
});

test("toolResultBlock omits isError when false, sets it when true", () => {
  expect(toolResultBlock("t1", "ok")).toEqual({ type: "tool_result", id: "t1", content: "ok" });
  expect(toolResultBlock("t2", "boom", true)).toEqual({
    type: "tool_result", id: "t2", content: "boom", isError: true,
  });
});

test("isToolCallBlock narrows tool_call blocks", () => {
  expect(isToolCallBlock({ type: "tool_call", id: "a", name: "x", input: {} })).toBe(true);
  expect(isToolCallBlock({ type: "text", text: "x" })).toBe(false);
});
