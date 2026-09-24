import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fakeProvider, textBlock } from "@lite-agent/core";
import type { AgentEvent, ModelProvider } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { tool } from "../src/tool";
import type { HookEvent } from "../src/hooks/types";

const config = () => {
  const root = mkdtempSync(join(tmpdir(), "hooks-"));
  return { workdir: root, home: join(root, "home"), tasks: false, agents: false, sessions: false, cleanup: false };
};
const reply = () => fakeProvider([{ message: { role: "assistant", content: [textBlock("ok")] } }]);

test("same-name hooks await registration order, can repeat the same callback, and unsubscribe independently", async () => {
  const agent = createLiteAgent({ ...config(), model: reply() });
  const order: string[] = [];
  const same = () => { order.push("same"); };
  const remove = agent.hook("run:end", same);
  agent.hook("run:end", async () => { await Promise.resolve(); order.push("async"); });
  agent.hook("run:end", same);
  await agent.send("one");
  expect(order).toEqual(["same", "async", "same"]);
  remove(); remove(); order.length = 0;
  await agent.send("two");
  expect(order).toEqual(["async", "same"]);
  await agent.close();
  expect(() => agent.hook("run:start", same)).toThrow(/closed/);
});

test("tool hooks cannot mutate execution input and a failed end handler never retries a successful tool", async () => {
  let executions = 0;
  const agent = createLiteAgent({ ...config(), model: fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "p", name: "probe", input: { value: 1 } }] } },
    { message: { role: "assistant", content: [textBlock("ok")] } },
  ]), tools: [tool("probe", "probe", z.object({ value: z.number() }), ({ value }) => { executions++; expect(value).toBe(1); return "success"; })] });
  const events: AgentEvent[] = [];
  agent.subscribe(({ event }) => events.push(event));
  agent.hook("tool:start", ({ call }) => { (call.input as { value: number }).value = 9; });
  agent.hook("tool:end", () => { throw new Error("audit unavailable"); });
  const observed: HookEvent[] = [];
  agent.hook("tool:end", (event) => { observed.push(event); });
  expect((await agent.send("go")).text).toBe("ok");
  expect(executions).toBe(1);
  expect(observed[0]).toMatchObject({ event: "tool:end", status: "completed", result: { content: "success" } });
  expect(events.filter((event) => event.type === "diagnostic" && event.code === "hook_failed")).toHaveLength(2);
  expect(events.find((event) => event.type === "tool_result")).toMatchObject({ result: { content: "success" } });
  await agent.close();
});

test("run:end executes exactly once on provider failure and early stream return", async () => {
  const failed = createLiteAgent({ ...config(), model: { id: "fail", async *stream() { throw new Error("provider failed"); } } });
  const failures: HookEvent[] = [];
  failed.hook("run:end", (event) => { failures.push(event); });
  await expect(failed.send("go")).rejects.toThrow("provider failed");
  expect(failures).toEqual([expect.objectContaining({ status: "failed", error: { name: "Error", message: "provider failed" } })]);
  await failed.close();

  const agent = createLiteAgent({ ...config(), model: reply() });
  const ends: HookEvent[] = [];
  agent.hook("run:end", (event) => { ends.push(event); });
  const stream = agent.run("go");
  await stream.next();
  await stream.return(undefined as never);
  expect(ends).toEqual([expect.objectContaining({ status: "cancelled" })]);
  await agent.close();
  expect(ends).toHaveLength(1);
});

test("hook timeout aborts its context and permits subsequent callbacks", async () => {
  const agent = createLiteAgent({ ...config(), model: reply() });
  let signal: AbortSignal | undefined;
  let continued = false;
  const events: AgentEvent[] = [];
  agent.subscribe(({ event }) => events.push(event));
  agent.hook("run:end", (_, ctx) => { signal = ctx.signal; return new Promise(() => {}); }, { timeoutMs: 15 });
  agent.hook("run:end", () => { continued = true; });
  await agent.send("go");
  expect(signal?.aborted).toBe(true);
  expect(continued).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ code: "hook_failed", message: expect.stringContaining("timed out") }));
  await agent.close();
});

test("reentrant agent operations fail explicitly instead of deadlocking", async () => {
  const agent = createLiteAgent({ ...config(), model: reply() });
  const events: AgentEvent[] = [];
  agent.subscribe(({ event }) => events.push(event));
  agent.hook("run:end", async () => { await agent.send("recursive"); });
  expect((await agent.send("go")).text).toBe("ok");
  expect(events).toContainEqual(expect.objectContaining({ code: "hook_failed", message: expect.stringContaining("same agent family") }));
  await agent.close();
});

test.each([false, true])("manual and automatic compaction hooks pair once (legacy=%s)", async (legacy) => {
  const events: HookEvent[] = [];
  const model: ModelProvider = { ...reply(), context: { contextWindow: 100, countTokens: async () => 80 } };
  const agent = createLiteAgent({ ...config(), model, ...(legacy ? { compactor: { async maybeCompact(messages: import("@lite-agent/core").Message[]) { return { messages }; } } } : {}) });
  agent.hook("compact:start", (event) => { events.push(event); });
  agent.hook("compact:end", (event) => { events.push(event); });
  await agent.send("go");
  expect(events.map((event) => event.event)).toEqual(["compact:start", "compact:end"]);
  expect(events[1]).toMatchObject({ status: "completed", source: "user" });
  events.length = 0;
  for await (const _ of agent.compact()) { /* drain */ }
  expect(events.map((event) => event.event)).toEqual(["compact:start", "compact:end"]);
  expect(events[1]).toMatchObject({ status: "completed", source: "manual" });
  await agent.close();
});

test("root registrations cover children and background runs with distinct identities", async () => {
  let rootCalls = 0;
  const model: ModelProvider = { id: "family", async *stream(request) {
    const child = request.system?.startsWith('You are the "');
    yield { type: "message_done", message: { role: "assistant", content: !child && rootCalls++ === 0
      ? [{ type: "tool_call", id: "a", name: "Agent", input: { tasks: [{ display_name: "Worker", subagent_type: "general-purpose", prompt: "go" }] } }]
      : [textBlock("done")] }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const agent = createLiteAgent({ ...config(), model, agents: true });
  const events: HookEvent[] = [];
  agent.hook("run:end", (event) => { events.push(event); });
  await agent.send("go"); await agent.awaitIdle();
  expect(events).toHaveLength(3);
  expect(new Set(events.map((event) => event.runId)).size).toBe(3);
  expect(events.filter((event) => event.agentId)).toHaveLength(1);
  expect(events.filter((event) => event.source === "background")).toHaveLength(1);
  await agent.close();
});

test("closing a run waiting on a start hook cancels it and still invokes run:end", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const agent = createLiteAgent({ ...config(), model: reply() });
  let end: HookEvent | undefined;
  agent.hook("run:start", () => { started(); return new Promise(() => {}); });
  agent.hook("run:end", (event) => { end = event; });
  const running = agent.send("go").catch(() => undefined);
  await ready;
  await agent.close();
  await running;
  expect(end).toMatchObject({ event: "run:end", status: "cancelled" });
});

test("failed manual compaction invokes compact:end once with the original failure", async () => {
  const agent = createLiteAgent({ ...config(), model: reply(), compactor: { async maybeCompact() { throw new Error("compaction failed"); } } });
  const ends: HookEvent[] = [];
  agent.hook("compact:end", (event) => { ends.push(event); });
  await expect((async () => { for await (const _ of agent.compact()) { /* drain */ } })()).rejects.toThrow("compaction failed");
  expect(ends).toEqual([expect.objectContaining({ source: "manual", status: "failed", error: { name: "Error", message: "compaction failed" } })]);
  await agent.close();
});
