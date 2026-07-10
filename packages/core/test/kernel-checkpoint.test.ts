import { expect, test } from "vitest";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { noopSandbox } from "../src/sandbox";
import { memoryCheckpointer, foldEvents } from "../src/checkpoint";
import { defineTool } from "../src/tools/define";
import { fakeProvider } from "../src/testing/fakeProvider";
import { textBlock } from "../src/types";
import { z } from "zod";
import type { ModelProvider } from "../src/strategies";
import type { AgentEvent, RunResult } from "../src/events";
import { permission, policy } from "../src/permission";

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: { id: "x", async *stream() {} }, codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
}
const run = async (gen: AsyncGenerator<AgentEvent, RunResult>) => { let r = await gen.next(); while (!r.done) r = await gen.next(); return r.value; };
const echo = defineTool({ name: "echo", description: "echo", schema: z.object({ v: z.string() }), execute: async ({ v }) => v });

test("a run appends user, assistant, and one tool_result event per call", async () => {
  const cp = memoryCheckpointer();
  let i = 0;
  const fp: ModelProvider = {
    id: "fp",
    async *stream() {
      const turn = i++;
      if (turn === 0) {
        yield { type: "message_done", message: { role: "assistant", content: [
          { type: "tool_call", id: "t1", name: "echo", input: { v: "A" } },
          { type: "tool_call", id: "t2", name: "echo", input: { v: "B" } },
        ] }, usage: { inputTokens: 0, outputTokens: 0 } };
      } else {
        yield { type: "message_done", message: { role: "assistant", content: [textBlock("done")] }, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    },
  };
  await run(runKernel(baseCfg({ provider: fp, tools: [echo], checkpointer: cp }), "hi", new AbortController().signal, "s"));
  const types: string[] = [];
  for await (const e of cp.read("s")) types.push(e.event.type);
  // user(hi), assistant(2 tool_calls), tool_result x2, assistant(done)
  expect(types).toEqual(["user", "assistant", "tool_result", "tool_result", "assistant"]);
});

test("resume replays the log so the model sees prior context", async () => {
  const cp = memoryCheckpointer();
  const seen: string[] = [];
  const recorder: ModelProvider = {
    id: "rec",
    async *stream(req) {
      seen.push(JSON.stringify(req.messages));
      yield { type: "message_done", message: { role: "assistant", content: [textBlock("ok")] }, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  await run(runKernel(baseCfg({ provider: recorder, checkpointer: cp }), "first", new AbortController().signal, "s"));
  await run(runKernel(baseCfg({ provider: recorder, checkpointer: cp }), "second", new AbortController().signal, "s"));
  // the second run's request includes the first turn's user+assistant
  expect(seen[1]).toContain("first");
  expect(seen[1]).toContain("ok");
  expect(seen[1]).toContain("second");
  // and the persisted log folds to the full conversation
  const events = [];
  for await (const e of cp.read("s")) events.push(e.event);
  expect(foldEvents(events).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
});

test("a tool's recordSnapshot persists a file_snapshot before its tool_result", async () => {
  const cp = memoryCheckpointer();
  const snap = defineTool({
    name: "snap", description: "s", schema: z.object({}),
    execute: (_i, ctx) => { ctx.recordSnapshot?.("f.txt", "OLD"); return "done"; },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "snap", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  await run(runKernel(baseCfg({ provider, tools: [snap], checkpointer: cp }), "hi", new AbortController().signal, "s1"));
  const types: string[] = [];
  for await (const e of cp.read("s1")) types.push(e.event.type);
  const iSnap = types.indexOf("file_snapshot");
  const iResult = types.indexOf("tool_result");
  expect(iSnap).toBeGreaterThanOrEqual(0);
  expect(iSnap).toBeLessThan(iResult);
});

test("permission audit uses the serialized append path before tool_result", async () => {
  const cp = memoryCheckpointer();
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "echo", input: { v: "A" } }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  await run(runKernel(baseCfg({
    provider,
    tools: [echo],
    middleware: [permission(policy({ allow: ["echo"] }), undefined, { audit: true })],
    checkpointer: cp,
  }), "hi", new AbortController().signal, "audit-session"));

  const events = [];
  for await (const e of cp.read("audit-session")) events.push(e.event);
  const types = events.map((e) => e.type);
  expect(types).toEqual(["user", "assistant", "permission_decision", "tool_result", "assistant"]);
  expect(events[2]).toMatchObject({ type: "permission_decision", decision: "allow", turn: 1 });
});

test("safe crash recovery synthesizes an interrupted result without executing the tool", async () => {
  const cp = memoryCheckpointer();
  await cp.append("recover", [
    { type: "user", message: { role: "user", content: "start" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_call", id: "lost", name: "echo", input: { v: "x" } }] } },
    { type: "tool_started", id: "lost", name: "echo", turn: 1 },
  ]);
  let ran = false;
  const guarded = { ...echo, execute: () => { ran = true; return "bad"; } };
  const provider = fakeProvider([{ text: "recovered", message: { role: "assistant", content: [textBlock("recovered")] } }]);
  const gen = runKernel(baseCfg({
    provider, tools: [guarded], checkpointer: cp, crashRecovery: "safe",
  }), "continue", new AbortController().signal, "recover");
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) { events.push(next.value); next = await gen.next(); }

  expect(ran).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_recovered", id: "lost", name: "echo" }));
  const stored = [];
  for await (const event of cp.read("recover")) stored.push(event.event);
  expect(stored[3]).toMatchObject({ type: "tool_result", result: { id: "lost", isError: true } });
});

test("session snapshot quota marks excess snapshots as truncated", async () => {
  const cp = memoryCheckpointer();
  const snapshots = defineTool({
    name: "snapshots",
    description: "snapshots",
    schema: z.object({}),
    async execute(_input, ctx) {
      await ctx.recordSnapshot?.("a.txt", "1234", undefined, "utf8");
      await ctx.recordSnapshot?.("b.txt", "5678", undefined, "utf8");
      return "ok";
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "s1", name: "snapshots", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  await run(runKernel(baseCfg({
    provider, tools: [snapshots], checkpointer: cp, maxSnapshotBytesPerSession: 5,
  }), "go", new AbortController().signal, "quota"));
  const events = [];
  for await (const event of cp.read("quota")) if (event.event.type === "file_snapshot") events.push(event.event);
  expect(events).toEqual([
    expect.objectContaining({ path: "a.txt", before: "1234", truncated: undefined }),
    expect.objectContaining({ path: "b.txt", before: null, truncated: true }),
  ]);
});
