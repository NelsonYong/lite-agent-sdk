import { expect, test } from "vitest";
import { composeModelCall, composeToolCall, runLifecycle } from "../src/middleware";
import type { AgentContext, Middleware, ToolCallContext } from "../src/middleware";
import type { ModelChunk, ToolResult } from "../src/types";

function baseCtx(): AgentContext {
  return {
    sessionId: "s1", messages: [], turn: 1,
    signal: new AbortController().signal, emit: () => {}, state: new Map(),
  };
}

test("wrapToolCall composes outer→inner in array order", async () => {
  const order: string[] = [];
  const mk = (name: string): Middleware => ({
    name,
    async wrapToolCall(_ctx, next) { order.push(`>${name}`); const r = await next(); order.push(`<${name}`); return r; },
  });
  const ctx = { ...baseCtx(), call: { id: "t1", name: "x", input: {} } } as ToolCallContext;
  const base = async (): Promise<ToolResult> => { order.push("exec"); return { id: "t1", name: "x", content: "ok" }; };
  const exec = composeToolCall([mk("A"), mk("B")], ctx, base);
  const result = await exec();
  expect(result.content).toBe("ok");
  expect(order).toEqual([">A", ">B", "exec", "<B", "<A"]);
});

test("a wrapToolCall middleware can short-circuit without calling next", async () => {
  const block: Middleware = {
    name: "block",
    async wrapToolCall(_ctx) { return { id: "t1", name: "x", content: "denied", isError: true }; },
  };
  const ctx = { ...baseCtx(), call: { id: "t1", name: "x", input: {} } } as ToolCallContext;
  let ran = false;
  const base = async (): Promise<ToolResult> => { ran = true; return { id: "t1", name: "x", content: "ok" }; };
  const result = await composeToolCall([block], ctx, base)();
  expect(ran).toBe(false);
  expect(result).toEqual({ id: "t1", name: "x", content: "denied", isError: true });
});

test("wrapModelCall composes around the base stream", async () => {
  const tag: Middleware = {
    name: "tag",
    async *wrapModelCall(_ctx, next) {
      yield { type: "text_delta", text: "[" };
      for await (const c of next()) yield c;
      yield { type: "text_delta", text: "]" };
    },
  };
  const base = async function* (): AsyncIterable<ModelChunk> { yield { type: "text_delta", text: "x" }; };
  const out: string[] = [];
  for await (const c of composeModelCall([tag], baseCtx(), base)()) {
    if (c.type === "text_delta") out.push(c.text);
  }
  expect(out).toEqual(["[", "x", "]"]);
});

test("runLifecycle invokes a hook on every middleware in order", async () => {
  const seen: string[] = [];
  const mk = (n: string): Middleware => ({ name: n, beforeModel: () => { seen.push(n); } });
  await runLifecycle([mk("A"), mk("B")], "beforeModel", baseCtx());
  expect(seen).toEqual(["A", "B"]);
});
