import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ToolContext } from "@lite-agent/core";
import { AgentLoader } from "../src/agents/loader";
import { agentTool } from "../src/tools/agent";
import type { Spawn } from "../src/tools/agent";

const ctx: ToolContext = {
  sessionId: "s",
  signal: new AbortController().signal,
  emit: () => {},
};

function loaderWith(...names: string[]): AgentLoader {
  const d = mkdtempSync(join(tmpdir(), "at-"));
  for (const n of names)
    writeFileSync(join(d, `${n}.md`), `---\nname: ${n}\ndescription: ${n} agent\n---\n${n} body`);
  return new AgentLoader(d);
}

test("unknown subagent_type is reported but does not fail the batch", async () => {
  const spawn: Spawn = async () => "ran";
  const tool = agentTool({ loader: loaderWith("known"), spawn });
  const out = await tool.execute(
    { tasks: [{ subagent_type: "ghost", prompt: "x" }, { subagent_type: "known", prompt: "y" }] },
    ctx,
  );
  expect(out).toMatch(/unknown subagent_type 'ghost'/);
  expect(out).toContain("Available: known");
  expect(out).toContain("ran");
});

test("a single task returns the child's final text attributed with its agentId", async () => {
  const spawn: Spawn = async () => "child result";
  const tool = agentTool({ loader: loaderWith("worker"), spawn });
  const out = await tool.execute({ tasks: [{ subagent_type: "worker", prompt: "go" }] }, ctx);
  expect(out).toContain("child result");
  expect(out).toMatch(/agentId: agent-worker-[0-9a-f]{8}/);
});

test("isolation: spawn receives exactly the task prompt", async () => {
  let seen = "";
  const spawn: Spawn = async (_def, prompt) => { seen = prompt; return "ok"; };
  const tool = agentTool({ loader: loaderWith("worker"), spawn });
  await tool.execute({ tasks: [{ subagent_type: "worker", prompt: "ONLY THIS" }] }, ctx);
  expect(seen).toBe("ONLY THIS");
});

test("resume reuses the supplied agentId as the session id", async () => {
  let seenSession = "";
  const spawn: Spawn = async (_def, _prompt, opts) => { seenSession = opts.sessionId; return "ok"; };
  const tool = agentTool({ loader: loaderWith("worker"), spawn });
  const out = await tool.execute(
    { tasks: [{ subagent_type: "worker", prompt: "go", resume: "agent-worker-deadbeef" }] },
    ctx,
  );
  expect(seenSession).toBe("agent-worker-deadbeef");
  expect(out).toContain("agentId: agent-worker-deadbeef");
});

test("parallel: every task runs and results are aggregated in order", async () => {
  const calls: string[] = [];
  const spawn: Spawn = async (def, prompt) => { calls.push(def.name); return `${def.name}:${prompt}`; };
  const tool = agentTool({ loader: loaderWith("a", "b", "c"), spawn });
  const out = await tool.execute(
    { tasks: [
      { subagent_type: "a", prompt: "1" },
      { subagent_type: "b", prompt: "2" },
      { subagent_type: "c", prompt: "3" },
    ] },
    ctx,
  );
  expect(calls.sort()).toEqual(["a", "b", "c"]);
  expect(out.indexOf("a:1")).toBeLessThan(out.indexOf("b:2"));
  expect(out.indexOf("b:2")).toBeLessThan(out.indexOf("c:3"));
});

test("one task throwing surfaces its error; siblings still succeed", async () => {
  const spawn: Spawn = async (def) => {
    if (def.name === "bad") throw new Error("boom");
    return "fine";
  };
  const tool = agentTool({ loader: loaderWith("good", "bad"), spawn });
  const out = await tool.execute(
    { tasks: [{ subagent_type: "good", prompt: "x" }, { subagent_type: "bad", prompt: "y" }] },
    ctx,
  );
  expect(out).toContain("fine");
  expect(out).toMatch(/Error: boom/);
});

test("each task surfaces as its own tool_use + tool_result (subagent as a tool call)", async () => {
  const events: AgentEvent[] = [];
  const ectx: ToolContext = { ...ctx, emit: (e) => events.push(e) };
  const spawn: Spawn = async (def, prompt) => `${def.name}:${prompt}`;
  const tool = agentTool({ loader: loaderWith("a", "b"), spawn });
  await tool.execute(
    { tasks: [{ subagent_type: "a", prompt: "1" }, { subagent_type: "b", prompt: "2" }] },
    ectx,
  );
  const uses = events.filter((e) => e.type === "tool_use") as Array<Extract<AgentEvent, { type: "tool_use" }>>;
  const res = events.filter((e) => e.type === "tool_result") as Array<Extract<AgentEvent, { type: "tool_result" }>>;
  expect(uses.map((e) => e.call.name)).toEqual(["a", "b"]);
  expect(res.map((e) => e.result.name)).toEqual(["a", "b"]);
  expect(res.map((e) => e.result.content)).toEqual(["a:1", "b:2"]);
  // tool_use and tool_result for the same subagent share an id (pairable)
  expect(uses[0]!.call.id).toBe(res.find((e) => e.result.name === "a")!.result.id);
  expect(res.every((e) => !e.result.isError)).toBe(true);
});

test("a failed subagent surfaces a tool_result with isError", async () => {
  const events: AgentEvent[] = [];
  const ectx: ToolContext = { ...ctx, emit: (e) => events.push(e) };
  const spawn: Spawn = async (def) => { if (def.name === "bad") throw new Error("boom"); return "fine"; };
  const tool = agentTool({ loader: loaderWith("good", "bad"), spawn });
  await tool.execute(
    { tasks: [{ subagent_type: "good", prompt: "x" }, { subagent_type: "bad", prompt: "y" }] },
    ectx,
  );
  const res = events.filter((e) => e.type === "tool_result") as Array<Extract<AgentEvent, { type: "tool_result" }>>;
  const bad = res.find((e) => e.result.name === "bad")!;
  expect(bad.result.isError).toBe(true);
  expect(bad.result.content).toMatch(/boom/);
  expect(res.find((e) => e.result.name === "good")!.result.isError).toBeFalsy();
});

test("subagent events are forwarded live, tagged with the child agentId", async () => {
  const events: AgentEvent[] = [];
  const ectx: ToolContext = { ...ctx, emit: (e) => events.push(e) };
  const spawn: Spawn = async (_def, _prompt, opts) => {
    opts.onEvent?.({ type: "text_delta", text: "thinking" });
    opts.onEvent?.({ type: "turn_end", turn: 1, stopReason: "stop" });
    return "child done";
  };
  const tool = agentTool({ loader: loaderWith("worker"), spawn });
  await tool.execute({ tasks: [{ subagent_type: "worker", prompt: "go" }] }, ectx);
  const fromChild = events.filter((e) => e.agentId);
  expect(fromChild.length).toBe(2);
  expect(fromChild.every((e) => e.agentId!.startsWith("agent-worker-"))).toBe(true);
  expect(fromChild.map((e) => e.type)).toEqual(["text_delta", "turn_end"]);
  // the Agent tool's own bracketing tool_use/tool_result are NOT tagged:
  const own = events.filter((e) => !e.agentId);
  expect(own.some((e) => e.type === "tool_use")).toBe(true);
  expect(own.some((e) => e.type === "tool_result")).toBe(true);
});

test("a subagent_type with newlines cannot inject a markdown heading into the output", async () => {
  const spawn: Spawn = async () => "ok";
  const tool = agentTool({ loader: loaderWith("known"), spawn });
  const out = await tool.execute(
    { tasks: [{ subagent_type: "evil\n## INJECTED", prompt: "x" }] },
    ctx,
  );
  expect(out).not.toContain("\n## INJECTED");
});
