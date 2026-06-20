import { expect, test, vi } from "vitest";
import { createLiteAgent } from "../src/createLiteAgent";
import { askUserTool } from "../src/tools";
import { fakeProvider, textBlock } from "@lite-agent/core";
import type { AgentEvent, InputHandler, ToolContext, ToolCall } from "@lite-agent/core";

function ctxWith(input: InputHandler | undefined, call: ToolCall, events: AgentEvent[]): ToolContext {
  return { sessionId: "s", signal: new AbortController().signal, emit: (e) => events.push(e), input, call };
}

test("ask_user emits request/resolved and returns the rendered text answer", async () => {
  const events: AgentEvent[] = [];
  const input: InputHandler = { request: vi.fn(async () => ({ text: "Bob" })) };
  const out = await askUserTool().execute(
    { question: "name?" },
    ctxWith(input, { id: "t1", name: "ask_user", input: {} }, events),
  );
  expect(out).toBe("Bob");
  expect(input.request).toHaveBeenCalledWith({ question: "name?" });
  expect(events).toEqual([
    { type: "input_request", call: { id: "t1", name: "ask_user", input: {} }, question: { question: "name?" } },
    { type: "input_resolved", id: "t1", answer: { text: "Bob" } },
  ]);
});

test("ask_user renders a multi-select answer as comma-joined", async () => {
  const events: AgentEvent[] = [];
  const input: InputHandler = { request: async () => ({ selected: ["a", "c"] }) };
  const out = await askUserTool().execute(
    { question: "pick", options: ["a", "b", "c"], multiSelect: true },
    ctxWith(input, { id: "t1", name: "ask_user", input: {} }, events),
  );
  expect(out).toBe("a, c");
});

test("ask_user without an input handler returns an error string", async () => {
  const events: AgentEvent[] = [];
  const out = await askUserTool().execute(
    { question: "x" },
    ctxWith(undefined, { id: "t1", name: "ask_user", input: {} }, events),
  );
  expect(out).toMatch(/unavailable/i);
  expect(events).toEqual([]);
});

async function drain(gen: AsyncGenerator<AgentEvent, unknown>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return events;
}

function scripted(toolName: string) {
  return fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: toolName, input: { question: "q?" } }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
}

test("createLiteAgent registers ask_user only when onAskUser is configured", async () => {
  const input: InputHandler = { request: async () => ({ text: "yes" }) };
  const withAsker = createLiteAgent({ model: scripted("ask_user"), workdir: process.cwd(), onAskUser: input });
  const events = await drain(withAsker.run("go"));
  const tr = events.find((e) => e.type === "tool_result");
  expect(tr).toMatchObject({ result: { content: "yes" } });
  expect(tr).not.toMatchObject({ result: { isError: true } });

  const withoutAsker = createLiteAgent({ model: scripted("ask_user"), workdir: process.cwd() });
  const events2 = await drain(withoutAsker.run("go"));
  const tr2 = events2.find((e) => e.type === "tool_result");
  expect(tr2).toMatchObject({ result: { isError: true } }); // unknown tool 'ask_user'
});
