import { expect, test } from "vitest";
import { agentTool } from "../src/tools/agent";
import type { Spawn } from "../src/tools/agent";
import { AgentLoader } from "../src/agents/loader";
import { builtinAgents } from "../src/agents/builtin";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";

const loader = () => new AgentLoader([], builtinAgents());
// A spawn stub that echoes the prompt back as the subagent's result.
const echoSpawn: Spawn = async (_def, prompt) => `RESULT(${prompt})`;

function ctxWithBackground() {
  const bg = createBackgroundTasks({ emit: (_e: AgentEvent) => {}, signal: new AbortController().signal });
  const emitted: AgentEvent[] = [];
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: (e: AgentEvent) => emitted.push(e), background: bg } as ToolContext;
  return { ctx, bg, emitted };
}

test("Agent defaults to background: returns a placeholder, delivers one aggregated notification", async () => {
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute(
    { tasks: [{ subagent_type: "general-purpose", prompt: "A" }, { subagent_type: "general-purpose", prompt: "B" }] },
    ctx,
  );
  expect(out).toMatch(/^\[background:bg_/);
  expect(out).toContain("2 subagent");
  expect(bg.pending()).toBe(1); // one batch = one task
  await bg.waitNext(new AbortController().signal);
  const [c] = bg.takeCompleted();
  expect(c!.content).toContain("RESULT(A)");
  expect(c!.content).toContain("RESULT(B)");
});

test("Agent with run_in_background:false blocks and returns the aggregate directly", async () => {
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  const { ctx } = ctxWithBackground();
  const out = await t.execute(
    { tasks: [{ subagent_type: "general-purpose", prompt: "X" }], run_in_background: false },
    ctx,
  );
  expect(out).toContain("RESULT(X)");
  expect(out).not.toMatch(/^\[background:/);
});

test("backgrounded subagent events route to the run-level emit, not ctx.emit", async () => {
  const runLevel: AgentEvent[] = [];
  const ctxEmit: AgentEvent[] = [];
  const bg = createBackgroundTasks({ emit: (e) => runLevel.push(e), signal: new AbortController().signal });
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: (e: AgentEvent) => ctxEmit.push(e), background: bg } as ToolContext;
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  await t.execute({ tasks: [{ subagent_type: "general-purpose", prompt: "Q" }] }, ctx);
  await bg.waitNext(new AbortController().signal);
  // runOne's tool_use + tool_result were emitted through the background run-level emit,
  // NOT through ctx.emit (which in the kernel would be the already-ended per-turn channel).
  expect(runLevel.some((e) => e.type === "tool_use")).toBe(true);
  expect(runLevel.some((e) => e.type === "tool_result")).toBe(true);
  expect(ctxEmit.length).toBe(0);
});
