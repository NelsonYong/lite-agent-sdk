import { expect, test } from "vitest";
import { z } from "zod";
import { runKernel } from "../src/kernel";
import type { KernelConfig } from "../src/kernel";
import { nativeCodec } from "../src/codecs/native";
import { fakeProvider } from "../src/testing/fakeProvider";
import { defineTool } from "../src/tools/define";
import { textBlock } from "../src/types";
import { noopSandbox } from "../src/sandbox";
import type { AgentEvent, RunResult } from "../src/events";

function baseCfg(over: Partial<KernelConfig>): KernelConfig {
  return { provider: fakeProvider([]), codec: nativeCodec(), tools: [], middleware: [], model: "fake", maxTurns: 10, sandbox: noopSandbox(), ...over };
}
async function drain(gen: AsyncGenerator<AgentEvent, RunResult>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}

// A tool that spawns a background task resolving after `ms`, and returns a placeholder immediately.
const bgTool = (ms: number) => defineTool({
  name: "bg",
  description: "spawn background work",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    if (!ctx.background) return "no background";
    const h = ctx.background.spawn({
      label: "work",
      run: () => new Promise<string>((r) => setTimeout(() => r("BG RESULT"), ms)),
    });
    return `[background:${h.id}] started.`;
  },
});

// A tool whose background task throws — exercises the isError completion path.
const bgErrTool = defineTool({
  name: "bgerr",
  description: "spawn failing background work",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    if (!ctx.background) return "no background";
    const h = ctx.background.spawn({ label: "boom", run: async () => { throw new Error("kaboom"); } });
    return `[background:${h.id}] started.`;
  },
});

// A tool that spawns a DETACHED task that never resolves unless aborted (a daemon).
let daemonAborted = false;
const daemonTool = defineTool({
  name: "daemon",
  description: "spawn a long-lived detached task",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    if (!ctx.background) return "no background";
    const h = ctx.background.spawn({
      label: "server",
      kind: "detached",
      run: (signal) => new Promise<string>((r) => signal.addEventListener("abort", () => { daemonAborted = true; r("stopped"); })),
    });
    return `[background:${h.id}] started.`;
  },
});

test("run joins background work: it does not stop until the task completes and its result is injected", async () => {
  // turn 1: call bg tool. turn 2+: model produces no tool calls (dry-out).
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bg", input: {} }] } },
    { text: "all done", message: { role: "assistant", content: [textBlock("all done")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [bgTool(10)] }), "go", new AbortController().signal, "s1"),
  );
  // The completion was delivered as an observational event...
  const completed = events.find((e) => e.type === "background_completed");
  expect(completed).toBeDefined();
  expect((completed as Extract<AgentEvent, { type: "background_completed" }>).completion.content).toBe("BG RESULT");
  // ...and the run only finished after joining (stopReason stop, done last).
  expect(result.stopReason).toBe("stop");
  expect(events[events.length - 1]!.type).toBe("done");
});

test("the injected notification reaches the model as a tagged user message", async () => {
  const seen: string[] = [];
  const inner = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bg", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  const provider = {
    id: "rec",
    stream: (req: Parameters<typeof inner.stream>[0], signal?: AbortSignal) => {
      for (const m of req.messages) if (typeof m.content === "string") seen.push(m.content);
      return inner.stream(req, signal);
    },
  };
  await drain(runKernel(baseCfg({ provider, tools: [bgTool(5)] }), "go", new AbortController().signal, "s1"));
  expect(seen.some((c) => c.includes("<background-task-completed") && c.includes("BG RESULT"))).toBe(true);
});

test("a slow background task does not exhaust the maxTurns budget", async () => {
  // maxTurns 2, but the model dry-outs on turn 2 while the task is still running.
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bg", input: {} }] } },
    { text: "waiting", message: { role: "assistant", content: [textBlock("waiting")] } },
    { text: "consumed", message: { role: "assistant", content: [textBlock("consumed")] } },
  ]);
  const { result } = await drain(
    runKernel(baseCfg({ provider, tools: [bgTool(30)], maxTurns: 2 }), "go", new AbortController().signal, "s1"),
  );
  // Without the maxTurns exemption this would end "max_turns" with a dangling task.
  expect(result.stopReason).toBe("stop");
});

test("background disabled: ctx.background is undefined and the tool runs synchronously", async () => {
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bg", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { events } = await drain(
    runKernel(baseCfg({ provider, tools: [bgTool(5)], background: false }), "go", new AbortController().signal, "s1"),
  );
  expect(events.some((e) => e.type === "background_completed")).toBe(false);
  const tr = events.find((e) => e.type === "tool_result");
  expect((tr as Extract<AgentEvent, { type: "tool_result" }>).result.content).toBe("no background");
});

test("aborting during a background join ends the run as aborted", async () => {
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bg", input: {} }] } },
    { text: "waiting", message: { role: "assistant", content: [textBlock("waiting")] } },
  ]);
  const ac = new AbortController();
  // The bg task takes 1s, but we abort while the join is waiting on it.
  const gen = runKernel(baseCfg({ provider, tools: [bgTool(1000)] }), "go", ac.signal, "s1");
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    // The 2nd turn_end is the join branch's turn_end (turn 1 = tool_use, turn 2 = dry-out join).
    if (r.value.type === "turn_end" && events.filter((e) => e.type === "turn_end").length >= 2) ac.abort();
    r = await gen.next();
  }
  expect(r.value.stopReason).toBe("aborted");
});

test("a still-pending background task is cancelled when the run hits maxTurns", async () => {
  let aborted = false;
  // Foreground tool: burns a turn each call (never dry-outs), and on its first call
  // spawns a background task that only settles if its signal aborts.
  const spawnBg = defineTool({
    name: "spawn_bg",
    description: "spawn one long-lived background task, then keep busy",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      if (ctx.background && ctx.background.pendingJoinable() === 0) {
        ctx.background.spawn({
          label: "long",
          run: (signal) => new Promise<string>((r) => signal.addEventListener("abort", () => { aborted = true; r("cancelled"); })),
        });
      }
      return "busy";
    },
  });
  // fakeProvider repeats its last turn, so every turn calls spawn_bg → never dry-out → hits maxTurns.
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "spawn_bg", input: {} }] } },
  ]);
  const { result } = await drain(
    runKernel(baseCfg({ provider, tools: [spawnBg], maxTurns: 3 }), "go", new AbortController().signal, "s1"),
  );
  expect(result.stopReason).toBe("max_turns");
  expect(aborted).toBe(true); // the pending task was cancelled on the maxTurns exit, not leaked
});

test("an error completion is injected with status=\"error\"", async () => {
  const seen: string[] = [];
  const inner = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bgerr", input: {} }] } },
    { text: "ok", message: { role: "assistant", content: [textBlock("ok")] } },
  ]);
  const provider = {
    id: "rec",
    stream: (req: Parameters<typeof inner.stream>[0], signal?: AbortSignal) => {
      for (const m of req.messages) if (typeof m.content === "string") seen.push(m.content);
      return inner.stream(req, signal);
    },
  };
  await drain(runKernel(baseCfg({ provider, tools: [bgErrTool] }), "go", new AbortController().signal, "s1"));
  expect(seen.some((c) => c.includes('status="error"') && c.includes("kaboom"))).toBe(true);
});

test("a detached daemon does NOT block dry-out: the run stops and the daemon is cancelled at run-end", async () => {
  daemonAborted = false;
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "daemon", input: {} }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);
  const { result } = await drain(
    runKernel(baseCfg({ provider, tools: [daemonTool] }), "go", new AbortController().signal, "s1"),
  );
  expect(result.stopReason).toBe("stop"); // NOT hung on the never-exiting daemon
  expect(daemonAborted).toBe(true); // cancelAll at run-end stopped it
});

test("a joinable task still blocks dry-out even when a detached daemon is also running", async () => {
  daemonAborted = false;
  // turn 1: start the daemon. turn 2: start a finite joinable bg. turn 3: dry-out → join on the joinable.
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "daemon", input: {} }] } },
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c2", name: "bg", input: {} }] } },
    { text: "waiting", message: { role: "assistant", content: [textBlock("waiting")] } },
    { text: "consumed", message: { role: "assistant", content: [textBlock("consumed")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [daemonTool, bgTool(10)] }), "go", new AbortController().signal, "s1"),
  );
  expect(events.some((e) => e.type === "background_completed")).toBe(true); // joinable was joined + injected
  expect(result.stopReason).toBe("stop");
  expect(daemonAborted).toBe(true); // daemon cancelled at run-end
});

test("a detached task that exits WHILE the run is active still injects a completion note", async () => {
  // The detached task resolves on the microtask queue (no external timer), so it is
  // finished by the turn-2 top drain — where takeCompleted() injects every completion,
  // joinable or detached. Push semantics for daemon exits, without gating the run.
  const detachedFinite = defineTool({
    name: "dfin",
    description: "spawn a detached task that finishes on its own",
    schema: z.object({}),
    execute: async (_input, ctx) => {
      const h = ctx.background!.spawn({ label: "srv", kind: "detached", run: async () => "SRV DONE" });
      return `[background:${h.id}] started.`;
    },
  });
  const provider = fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "dfin", input: {} }] } },
    { text: "idle", message: { role: "assistant", content: [textBlock("idle")] } },
  ]);
  const { events, result } = await drain(
    runKernel(baseCfg({ provider, tools: [detachedFinite] }), "go", new AbortController().signal, "s1"),
  );
  const completed = events.find((e) => e.type === "background_completed");
  expect(completed).toBeDefined();
  expect((completed as Extract<AgentEvent, { type: "background_completed" }>).completion.content).toBe("SRV DONE");
  expect(result.stopReason).toBe("stop");
});
