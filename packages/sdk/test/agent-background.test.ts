import { expect, test, vi } from "vitest";
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

test("Agent defaults to blocking: returns the aggregate directly, no placeholder", async () => {
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  const { ctx } = ctxWithBackground();
  const out = await t.execute(
    { tasks: [{ subagent_type: "general-purpose", prompt: "A" }, { subagent_type: "general-purpose", prompt: "B" }] },
    ctx,
  );
  expect(out).not.toMatch(/^\[background:/);
  expect(out).toContain("RESULT(A)");
  expect(out).toContain("RESULT(B)");
});

test("Agent with run_in_background:true backgrounds as one detached task", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deferredSpawn: Spawn = async (_def, prompt) => {
    await gate;
    return `RESULT(${prompt})`;
  };
  const t = agentTool({ loader: loader(), spawn: deferredSpawn });
  const { ctx, bg } = ctxWithBackground();
  const out = await t.execute(
    { tasks: [{ subagent_type: "general-purpose", prompt: "A" }, { subagent_type: "general-purpose", prompt: "B" }], run_in_background: true },
    ctx,
  );
  expect(out).toMatch(/^\[background:bg_/);
  expect(out).toContain("2 subagent");
  expect(bg.pendingDetached()).toBe(1);
  expect(bg.pendingJoinable()).toBe(0);
  release();
  await vi.waitFor(() => expect(bg.hasCompleted()).toBe(true));
  const [c] = bg.takeCompleted();
  expect(c!.content).toContain("RESULT(A)");
  expect(c!.content).toContain("RESULT(B)");
});

test("backgrounded subagent events route to the run-level emit, not ctx.emit", async () => {
  const runLevel: AgentEvent[] = [];
  const ctxEmit: AgentEvent[] = [];
  const bg = createBackgroundTasks({ emit: (e) => runLevel.push(e), signal: new AbortController().signal });
  const ctx = { sessionId: "s", signal: new AbortController().signal, emit: (e: AgentEvent) => ctxEmit.push(e), background: bg } as ToolContext;
  const t = agentTool({ loader: loader(), spawn: echoSpawn });
  await t.execute({ tasks: [{ subagent_type: "general-purpose", prompt: "Q" }], run_in_background: true }, ctx);
  await vi.waitFor(() => expect(bg.hasCompleted()).toBe(true));
  expect(runLevel.some((e) => e.type === "tool_use")).toBe(true);
  expect(runLevel.some((e) => e.type === "tool_result")).toBe(true);
  expect(ctxEmit.length).toBe(0);
});
