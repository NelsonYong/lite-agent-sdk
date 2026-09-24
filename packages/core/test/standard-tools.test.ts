import { expect, test } from "vitest";
import { z } from "zod";
import { createAgent, fakeProvider, nativeCodec, permission, defineTool, textBlock, toToolSpec } from "../src/index";
import type { Tool } from "../src/index";

test("Standard Schema tools support asynchronous validation and structured failures", async () => {
  let executed = false;
  const tool: Tool = { name: "probe", description: "probe", schema: { "~standard": {
    version: 1, vendor: "fixture", validate: async (input) => typeof input === "string" ? { value: input } : { issues: [{ message: "expected string" }] },
    jsonSchema: { input: () => ({ type: "string" }) },
  } }, execute: () => { executed = true; return { content: "business failure", isError: true }; } };
  expect(toToolSpec(tool).parameters).toEqual({ type: "string" });
  const model = () => fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c", name: "probe", input: "ok" }] } },
    { message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const agent = createAgent({ model: model(), codec: nativeCodec(), tools: [tool] });
  const result = await agent.send("go");
  expect(executed).toBe(true);
  expect(JSON.stringify(result.messages)).toContain('"isError":true');
  expect(JSON.stringify(result.messages)).toContain("business failure");
});

test("permission checks see schema-transformed effective arguments", async () => {
  let executed = false;
  const probe = defineTool({ name: "probe", description: "probe", schema: z.object({ path: z.string().transform(() => "/outside") }), execute: () => { executed = true; return "bad"; } });
  const agent = createAgent({ codec: nativeCodec(), tools: [probe], model: fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c", name: "probe", input: { path: "/workspace" } }] } },
    { message: { role: "assistant", content: [textBlock("done")] } },
  ]), use: [permission({ check: (call) => (call.input as { path: string }).path === "/workspace" ? "allow" : "deny" })] });
  await agent.send("go");
  expect(executed).toBe(false);
});

test("a throwing or cancelled asynchronous validator cannot execute its tool", async () => {
  for (const cancelled of [false, true]) {
    let executed = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const controller = new AbortController();
    const tool: Tool = { name: "probe", description: "probe", schema: { "~standard": {
      version: 1, vendor: "fixture", validate: () => {
        started();
        if (cancelled) return new Promise(() => {});
        throw undefined;
      },
      jsonSchema: { input: () => ({ type: "object" }) },
    } }, execute: () => { executed = true; return "unsafe"; } };
    const agent = createAgent({ codec: nativeCodec(), tools: [tool], model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "c", name: "probe", input: {} }] } },
      { message: { role: "assistant", content: [textBlock("done")] } },
    ]) });
    const run = agent.send("go", { signal: controller.signal });
    await ready;
    if (cancelled) controller.abort();
    await run;
    expect(executed).toBe(false);
  }
});
