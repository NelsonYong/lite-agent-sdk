import { expect, test } from "vitest";
import { SteerController } from "../src/steer";
import { z } from "zod";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import type { FakeTurn } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { textBlock } from "../src/types";
import type { Message, ModelRequest } from "../src/types";
import type { ModelProvider } from "../src/strategies";
import type { AgentEvent, RunResult } from "../src/events";
import { noopSandbox } from "../src/sandbox";

test("SteerController normalizes strings to user messages and drains once", () => {
  const s = new SteerController();
  s.steer("a");
  s.steer({ role: "user", content: "b" });
  s.followUp("c");
  expect(s.takeSteers()).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
  expect(s.takeSteers()).toEqual([]); // drained
  expect(s.takeFollowUps()).toEqual([{ role: "user", content: "c" }]);
  expect(s.takeFollowUps()).toEqual([]);
});

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: fakeProvider([]), codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
}

async function drain(gen: AsyncGenerator<AgentEvent, RunResult>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}

// A provider that snapshots each model call's messages, wrapping a scripted fakeProvider.
function recordingProvider(script: FakeTurn[]) {
  const seen: Message[][] = [];
  const inner = fakeProvider(script);
  const provider: ModelProvider = {
    id: "rec",
    stream: (req: ModelRequest, signal?: AbortSignal) => { seen.push([...req.messages]); return inner.stream(req, signal); },
  };
  return { provider, seen };
}

test("steer injects a user message before the next model turn", async () => {
  const { provider, seen } = recordingProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "noop", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const noop = defineTool({ name: "noop", description: "n", schema: z.object({}), execute: async () => "ok" });
  const steer = new SteerController();
  const gen = runKernel(baseCfg({ provider, tools: [noop], steer }), "hi", new AbortController().signal, "s1");
  // Drive turn 1, then steer right after the first turn_end, before turn 2's model call.
  let injected = false;
  const events: AgentEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) break;
    events.push(r.value);
    if (r.value.type === "turn_end" && !injected) { steer.steer("MID-RUN"); injected = true; }
  }
  const lastCallMsgs = seen[seen.length - 1]!;
  expect(lastCallMsgs.some((m) => m.role === "user" && m.content === "MID-RUN")).toBe(true);
  expect(events.some((e) => e.type === "steer")).toBe(true);
});

test("followUp continues a run that would otherwise stop", async () => {
  const { provider } = recordingProvider([
    { text: "first", message: { role: "assistant", content: [textBlock("first")] } },  // no tools → would stop
    { text: "second", message: { role: "assistant", content: [textBlock("second")] } }, // also no tools
  ]);
  const steer = new SteerController();
  steer.followUp("keep going");
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, steer }), "hi", new AbortController().signal, "s1"),
  );
  const turnStarts = events.filter((e) => e.type === "turn_start").length;
  expect(turnStarts).toBe(2);                 // resurrected for a second turn
  expect(result.stopReason).toBe("stop");     // the second turn (no followUp left) stops cleanly
  expect(events.some((e) => e.type === "steer")).toBe(true);
});
