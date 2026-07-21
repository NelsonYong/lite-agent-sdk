import { expect, test, vi } from "vitest";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";
import { agentTool } from "../src/tools/agent";
import type { Spawn, SubagentResult } from "../src/tools/agent";
import { AgentLoader } from "../src/agents/loader";
import { builtinAgents } from "../src/agents/builtin";
import { createSubagentPool } from "../src/subagentPool";

const loader = () => new AgentLoader([], builtinAgents());
const completed = (text: string): SubagentResult => ({ status: "completed", text, stopReason: "stop" });
const echoSpawn: Spawn = async (_def, prompt) => completed(`RESULT(${prompt})`);

function toolWith(spawn: Spawn) {
  return agentTool({ loader: loader(), spawn, pool: createSubagentPool(5) });
}

function ctxWithBackground(opts: { events?: AgentEvent[]; onCompleted?: () => void } = {}) {
  const bg = createBackgroundTasks({
    emit: (event) => opts.events?.push(event),
    signal: new AbortController().signal,
    onCompleted: opts.onCompleted,
  });
  const ctx = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: () => {},
    background: bg,
  } as ToolContext;
  return { ctx, bg };
}

async function completion(bg: ReturnType<typeof createBackgroundTasks>) {
  await vi.waitFor(() => expect(bg.hasCompleted()).toBe(true));
  const completions = bg.takeCompleted();
  expect(completions).toHaveLength(1);
  return completions[0]!;
}

test("Agent always backgrounds a group and ignores run_in_background", async () => {
  const t = toolWith(echoSpawn);
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute(
    { tasks: [
      { display_name: "First", subagent_type: "general-purpose", prompt: "A" },
      { display_name: "Second", subagent_type: "general-purpose", prompt: "B" },
    ], run_in_background: false },
    ctx,
  );
  expect(out).toMatch(/^\[background:bg_/);
  expect(out).toContain("accepted group with 2 subagents");
  const result = await completion(bg);
  expect(result.status).toBe("completed");
  expect(result.content).toContain("RESULT(A)");
  expect(result.content).toContain("RESULT(B)");
});

test("a group publishes exactly one completion after every child settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const completionSpy = vi.fn();
  const deferredSpawn: Spawn = async (_def, prompt) => {
    if (prompt === "slow") await gate;
    return completed(`RESULT(${prompt})`);
  };
  const t = toolWith(deferredSpawn);
  const { ctx, bg } = ctxWithBackground({ onCompleted: completionSpy });
  await t.execute(
    { tasks: [
      { display_name: "Fast", subagent_type: "general-purpose", prompt: "fast" },
      { display_name: "Slow", subagent_type: "general-purpose", prompt: "slow" },
    ] },
    ctx,
  );
  await vi.waitFor(() => expect(bg.pendingJoinable()).toBe(1));
  expect(bg.hasCompleted()).toBe(false);
  expect(completionSpy).not.toHaveBeenCalled();
  release();
  const result = await completion(bg);
  expect(result.status).toBe("completed");
  expect(completionSpy).toHaveBeenCalledTimes(1);
  expect(result.content).toContain("RESULT(fast)");
  expect(result.content).toContain("RESULT(slow)");
});

test("backgrounded subagent events route to the run-level emit, not ctx.emit", async () => {
  const runLevel: AgentEvent[] = [];
  const ctxEmit: AgentEvent[] = [];
  const bg = createBackgroundTasks({ emit: (event) => runLevel.push(event), signal: new AbortController().signal });
  const ctx = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: (event: AgentEvent) => ctxEmit.push(event),
    background: bg,
  } as ToolContext;
  const t = toolWith(echoSpawn);
  await t.execute({ tasks: [{ display_name: "Question", subagent_type: "general-purpose", prompt: "Q" }] }, ctx);
  await completion(bg);
  expect(runLevel.some((event) => event.type === "tool_use")).toBe(true);
  expect(runLevel.some((event) => event.type === "tool_result")).toBe(true);
  expect(ctxEmit).toHaveLength(0);
});

test.each([
  ["max_turns", async (): Promise<SubagentResult> => ({ status: "completed", text: "unfinished", stopReason: "max_turns" })],
  ["empty final text", async (): Promise<SubagentResult> => ({ status: "completed", text: "", stopReason: "stop" })],
  ["throw", async (): Promise<SubagentResult> => { throw new Error("boom"); }],
])("%s produces an error completion", async (_name, spawn) => {
  const t = toolWith(spawn);
  const { ctx, bg } = ctxWithBackground();
  await t.execute({ tasks: [{ display_name: "Worker", subagent_type: "general-purpose", prompt: "go" }] }, ctx);
  const result = await completion(bg);
  expect(result.status).toBe("failed");
  expect(result.isError).toBe(true);
});
