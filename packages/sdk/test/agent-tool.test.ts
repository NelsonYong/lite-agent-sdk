import { expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackgroundTasks } from "@lite-agent/core";
import type { AgentEvent, ToolContext } from "@lite-agent/core";
import { AgentLoader } from "../src/agents/loader";
import { createSubagentPool } from "../src/subagentPool";
import { agentTool } from "../src/tools/agent";
import type { Spawn, SubagentResult } from "../src/tools/agent";
import type { SubagentResult as PublicSubagentResult, SubagentStatus as PublicSubagentStatus } from "../src/index";

const completed = (text: string): SubagentResult => ({ status: "completed", text, stopReason: "stop" });

function loaderWith(...names: string[]): AgentLoader {
  const d = mkdtempSync(join(tmpdir(), "at-"));
  for (const n of names)
    writeFileSync(join(d, `${n}.md`), `---\nname: ${n}\ndescription: ${n} agent\n---\n${n} body`);
  return new AgentLoader(d);
}

function toolWith(loader: AgentLoader, spawn: Spawn) {
  return agentTool({ loader, spawn, pool: createSubagentPool(5) });
}

function ctxWithBackground(events: AgentEvent[] = []) {
  const bg = createBackgroundTasks({ emit: (event) => events.push(event), signal: new AbortController().signal });
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

test("task schema rejects a missing or empty display_name", () => {
  const tool = toolWith(loaderWith("worker"), async () => completed("ok"));
  expect(tool.schema.safeParse({ tasks: [{ subagent_type: "worker", prompt: "go" }] }).success).toBe(false);
  expect(tool.schema.safeParse({ tasks: [{ display_name: " ", subagent_type: "worker", prompt: "go" }] }).success).toBe(false);
  expect(tool.schema.safeParse({ tasks: [{ display_name: "\u0007", subagent_type: "worker", prompt: "go" }] }).success).toBe(false);
  const displayName = "  中文 Agent  ";
  const parsed = tool.schema.parse({ tasks: [{ display_name: displayName, subagent_type: "worker", prompt: "go" }] }) as {
    tasks: Array<{ display_name: string }>;
  };
  expect(parsed.tasks[0]!.display_name).toBe(displayName);
});

test("public SDK types expose subagent terminal results", () => {
  const result: PublicSubagentResult = completed("ok");
  const status: PublicSubagentStatus = result.status;
  expect(status).toBe("completed");
});

test("Agent requires an enabled background registry", async () => {
  const tool = toolWith(loaderWith("worker"), async () => completed("ok"));
  const noBackground: ToolContext = {
    sessionId: "s",
    signal: new AbortController().signal,
    emit: () => {},
  };
  await expect(tool.execute({ tasks: [{ display_name: "worker", subagent_type: "worker", prompt: "go" }] }, noBackground))
    .rejects.toThrow(/enable background/i);
});

test("Agent rejects a control-only display_name when execute bypasses schema parsing", async () => {
  const tool = toolWith(loaderWith("worker"), async () => completed("ok"));
  const { ctx } = ctxWithBackground();
  await expect(tool.execute({ tasks: [{ display_name: "\u0007", subagent_type: "worker", prompt: "go" }] }, ctx))
    .rejects.toThrow(/display_name must contain visible characters/i);
});

test("unknown subagent_type is reported but does not fail the group", async () => {
  const spawn: Spawn = async () => completed("ran");
  const tool = toolWith(loaderWith("known"), spawn);
  const { ctx, bg } = ctxWithBackground();
  const out = await tool.execute(
    { tasks: [
      { display_name: "Missing", subagent_type: "ghost", prompt: "x" },
      { display_name: "Known", subagent_type: "known", prompt: "y" },
    ] },
    ctx,
  );
  expect(out).toMatch(/^\[background:bg_/);
  const result = await completion(bg);
  expect(result.status).toBe("partial");
  expect(result.content).toMatch(/unknown subagent_type 'ghost'/);
  expect(result.content).toContain("Available: known");
  expect(result.content).toContain("ran");
});

test("unknown subagent_type diagnostics clean control characters but retain raw synthetic input", async () => {
  const events: AgentEvent[] = [];
  const subagentType = "ghost\u001b[31m";
  const tool = toolWith(loaderWith("known"), async () => completed("ran"));
  const { ctx, bg } = ctxWithBackground(events);
  await tool.execute({ tasks: [{ display_name: "Missing", subagent_type: subagentType, prompt: "x" }] }, ctx);
  const result = await completion(bg);
  const use = events.find((event) => event.type === "tool_use") as Extract<AgentEvent, { type: "tool_use" }>;
  expect(use.call.input).toEqual({ display_name: "Missing", subagent_type: subagentType, prompt: "x" });
  expect(result.content).toContain("unknown subagent_type 'ghost [31m'");
  expect(result.content).not.toContain("\u001b");
});

test("a single task returns the child's final text attributed with its agentId", async () => {
  const spawn: Spawn = async () => completed("child result");
  const tool = toolWith(loaderWith("worker"), spawn);
  const { ctx, bg } = ctxWithBackground();
  await tool.execute({ tasks: [{ display_name: "Worker", subagent_type: "worker", prompt: "go" }] }, ctx);
  const result = await completion(bg);
  expect(result.status).toBe("completed");
  expect(result.content).toContain("child result");
  expect(result.content).toMatch(/agentId: agent-worker-[0-9a-f]{8}/);
});

test("isolation: spawn receives exactly the task prompt", async () => {
  let seen = "";
  const spawn: Spawn = async (_def, prompt) => { seen = prompt; return completed("ok"); };
  const tool = toolWith(loaderWith("worker"), spawn);
  const { ctx, bg } = ctxWithBackground();
  await tool.execute({ tasks: [{ display_name: "Worker", subagent_type: "worker", prompt: "ONLY THIS" }] }, ctx);
  await completion(bg);
  expect(seen).toBe("ONLY THIS");
});

test("resume reuses the supplied agentId as the session id", async () => {
  let seenSession = "";
  const spawn: Spawn = async (_def, _prompt, opts) => { seenSession = opts.sessionId; return completed("ok"); };
  const tool = toolWith(loaderWith("worker"), spawn);
  const { ctx, bg } = ctxWithBackground();
  await tool.execute(
    { tasks: [{ display_name: "Worker", subagent_type: "worker", prompt: "go", resume: "agent-worker-deadbeef" }] },
    ctx,
  );
  const result = await completion(bg);
  expect(seenSession).toBe("agent-worker-deadbeef");
  expect(result.content).toContain("agentId: agent-worker-deadbeef");
});

test("parallel: every task runs and results are aggregated in order", async () => {
  const calls: string[] = [];
  const spawn: Spawn = async (def, prompt) => { calls.push(def.name); return completed(`${def.name}:${prompt}`); };
  const tool = toolWith(loaderWith("a", "b", "c"), spawn);
  const { ctx, bg } = ctxWithBackground();
  await tool.execute(
    { tasks: [
      { display_name: "A", subagent_type: "a", prompt: "1" },
      { display_name: "B", subagent_type: "b", prompt: "2" },
      { display_name: "C", subagent_type: "c", prompt: "3" },
    ] },
    ctx,
  );
  const result = await completion(bg);
  expect(calls.sort()).toEqual(["a", "b", "c"]);
  expect(result.content.indexOf("a:1")).toBeLessThan(result.content.indexOf("b:2"));
  expect(result.content.indexOf("b:2")).toBeLessThan(result.content.indexOf("c:3"));
});

test("one failed child and two successful children make the group partial", async () => {
  const spawn: Spawn = async (def) => def.name === "bad"
    ? { status: "failed", error: "boom" }
    : completed("fine");
  const tool = toolWith(loaderWith("good", "bad"), spawn);
  const { ctx, bg } = ctxWithBackground();
  await tool.execute(
    { tasks: [
      { display_name: "First", subagent_type: "good", prompt: "x" },
      { display_name: "Broken", subagent_type: "bad", prompt: "y" },
      { display_name: "Last", subagent_type: "good", prompt: "z" },
    ] },
    ctx,
  );
  const result = await completion(bg);
  expect(result.status).toBe("partial");
  expect(result.isError).toBe(true);
  expect(result.content).toContain("First");
  expect(result.content).toContain("Broken");
  expect(result.content).toContain("Last");
  expect(result.content).toContain("fine");
  expect(result.content).toContain("boom");
});

test("display names distinguish same-type child tool events and aggregate titles", async () => {
  const events: AgentEvent[] = [];
  const spawn: Spawn = async (_def, prompt) => completed(`done:${prompt}`);
  const tool = toolWith(loaderWith("general-purpose"), spawn);
  const { ctx, bg } = ctxWithBackground(events);
  await tool.execute(
    { tasks: [
      { display_name: "Research Notes", subagent_type: "general-purpose", prompt: "research" },
      { display_name: "Write Draft", subagent_type: "general-purpose", prompt: "write" },
    ] },
    ctx,
  );
  const result = await completion(bg);
  const uses = events.filter((event) => event.type === "tool_use") as Array<Extract<AgentEvent, { type: "tool_use" }>>;
  const outcomes = events.filter((event) => event.type === "tool_result") as Array<Extract<AgentEvent, { type: "tool_result" }>>;
  expect(uses.map((event) => event.call.name)).toEqual(["Research Notes", "Write Draft"]);
  expect(outcomes.map((event) => event.result.name)).toEqual(["Research Notes", "Write Draft"]);
  expect(uses.map((event) => event.call.input)).toEqual([
    { display_name: "Research Notes", subagent_type: "general-purpose", prompt: "research" },
    { display_name: "Write Draft", subagent_type: "general-purpose", prompt: "write" },
  ]);
  expect(result.content).toContain("Research Notes");
  expect(result.content).toContain("Write Draft");
});

test("display names preserve Unicode, punctuation, and ordinary whitespace while replacing control characters", async () => {
  const events: AgentEvent[] = [];
  const displayName = "  调研・设计\u0007  —  第一轮  ";
  const tool = toolWith(loaderWith("worker"), async () => completed("ok"));
  const { ctx, bg } = ctxWithBackground(events);
  await tool.execute({ tasks: [{ display_name: displayName, subagent_type: "worker", prompt: "go" }] }, ctx);
  const result = await completion(bg);
  const use = events.find((event) => event.type === "tool_use") as Extract<AgentEvent, { type: "tool_use" }>;
  expect(use.call.name).toBe("  调研・设计   —  第一轮  ");
  expect(use.call.input).toEqual({ display_name: displayName, subagent_type: "worker", prompt: "go" });
  expect(result.content).toContain("  调研・设计   —  第一轮  ");
});

test("a failed subagent surfaces a tool_result with isError", async () => {
  const events: AgentEvent[] = [];
  const spawn: Spawn = async (def) => def.name === "bad"
    ? { status: "failed", error: "boom" }
    : completed("fine");
  const tool = toolWith(loaderWith("good", "bad"), spawn);
  const { ctx, bg } = ctxWithBackground(events);
  await tool.execute(
    { tasks: [
      { display_name: "Good", subagent_type: "good", prompt: "x" },
      { display_name: "Bad", subagent_type: "bad", prompt: "y" },
    ] },
    ctx,
  );
  await completion(bg);
  const outcomes = events.filter((event) => event.type === "tool_result") as Array<Extract<AgentEvent, { type: "tool_result" }>>;
  const bad = outcomes.find((event) => event.result.name === "Bad")!;
  expect(bad.result.isError).toBe(true);
  expect(bad.result.content).toMatch(/boom/);
  expect(outcomes.find((event) => event.result.name === "Good")!.result.isError).toBeFalsy();
});

test("subagent events are forwarded live, tagged with the child agentId", async () => {
  const events: AgentEvent[] = [];
  const spawn: Spawn = async (_def, _prompt, opts) => {
    opts.onEvent?.({ type: "text_delta", text: "thinking" });
    opts.onEvent?.({ type: "turn_end", turn: 1, stopReason: "stop" });
    return completed("child done");
  };
  const tool = toolWith(loaderWith("worker"), spawn);
  const { ctx, bg } = ctxWithBackground(events);
  await tool.execute({ tasks: [{ display_name: "Worker", subagent_type: "worker", prompt: "go" }] }, ctx);
  await completion(bg);
  const fromChild = events.filter((event) => event.agentId);
  expect(fromChild).toHaveLength(2);
  expect(fromChild.every((event) => event.agentId!.startsWith("agent-worker-"))).toBe(true);
  expect(fromChild.map((event) => event.type)).toEqual(["text_delta", "turn_end"]);
  const own = events.filter((event) => !event.agentId);
  expect(own.some((event) => event.type === "tool_use")).toBe(true);
  expect(own.some((event) => event.type === "tool_result")).toBe(true);
});

test("a display name with newlines cannot inject a markdown heading into the output", async () => {
  const tool = toolWith(loaderWith("known"), async () => completed("ok"));
  const { ctx, bg } = ctxWithBackground();
  await tool.execute(
    { tasks: [{ display_name: "evil\n## INJECTED", subagent_type: "known", prompt: "x" }] },
    ctx,
  );
  const result = await completion(bg);
  expect(result.content).not.toContain("\n## INJECTED");
});
