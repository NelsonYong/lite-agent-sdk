import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock, ProviderError } from "@lite-agent/core";
import type { Message } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { resolveProjectPaths } from "../src/paths";

const home = () => process.env.LITE_AGENT_HOME!;
const freshWorkdir = () => mkdtempSync(join(tmpdir(), "wd-"));
const sayOk = () => fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]);

const callTool = (name: string, input: Record<string, unknown>) =>
  fakeProvider([
    { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name, input }] } },
    { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
  ]);

async function toolResults(agent: ReturnType<typeof createLiteAgent>): Promise<string> {
  const out: string[] = [];
  for await (const ev of agent.run("hi")) if (ev.type === "tool_result") out.push(ev.result.content);
  return out.join("");
}

test("sessions on by default → transcript written under sessionsDir", async () => {
  const workdir = freshWorkdir();
  const agent = createLiteAgent({ model: sayOk(), workdir });
  await agent.send("hi", { sessionId: "sess1" });
  const { sessionsDir } = resolveProjectPaths({ workdir, home: home() });
  expect(existsSync(join(sessionsDir, "sess1.jsonl"))).toBe(true);
});

test("sessions:false → nothing written", async () => {
  const workdir = freshWorkdir();
  const agent = createLiteAgent({ model: sayOk(), workdir, sessions: false });
  await agent.send("hi", { sessionId: "sess2" });
  const { sessionsDir } = resolveProjectPaths({ workdir, home: home() });
  expect(existsSync(join(sessionsDir, "sess2.jsonl"))).toBe(false);
});

test("home override redirects where sessions are written", async () => {
  const workdir = freshWorkdir();
  const customHome = mkdtempSync(join(tmpdir(), "home-"));
  const agent = createLiteAgent({ model: sayOk(), workdir, home: customHome });
  await agent.send("hi", { sessionId: "sess3" });
  const { sessionsDir } = resolveProjectPaths({ workdir, home: customHome });
  expect(existsSync(join(sessionsDir, "sess3.jsonl"))).toBe(true);
});

test("spill on by default → read_spilled is registered", async () => {
  const agent = createLiteAgent({ model: callTool("read_spilled", { ref: "nope" }), workdir: freshWorkdir() });
  expect(await toolResults(agent)).toContain("No spilled content for ref 'nope'");
});

test("spill:false → read_spilled is not registered", async () => {
  const agent = createLiteAgent({ model: callTool("read_spilled", { ref: "nope" }), workdir: freshWorkdir(), spill: false });
  expect(await toolResults(agent)).toMatch(/unknown tool/);
});

test("compactor:false → no compaction even on a history that would trigger", async () => {
  const turn = (i: number): Message[] => [
    { role: "user", content: `q${i}` },
    { role: "assistant", content: [{ type: "tool_call", id: `c${i}`, name: "f", input: {} }] },
    { role: "user", content: [{ type: "tool_result", id: `c${i}`, content: `r${i}-`.repeat(50) }] },
  ];
  const history = [0, 1, 2, 3, 4, 5].flatMap(turn);
  const agent = createLiteAgent({ model: sayOk(), workdir: freshWorkdir(), compactor: false });
  const types: string[] = [];
  for await (const ev of agent.run(history)) types.push(ev.type);
  expect(types).not.toContain("compaction");
});

test("a project skill shadows a same-named global skill", async () => {
  const workdir = freshWorkdir();
  const { globalSkillsDir, projectSkillsDir } = resolveProjectPaths({ workdir, home: home() });
  mkdirSync(join(globalSkillsDir, "demo"), { recursive: true });
  mkdirSync(join(projectSkillsDir, "demo"), { recursive: true });
  writeFileSync(join(globalSkillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: g\n---\nGLOBAL BODY");
  writeFileSync(join(projectSkillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: p\n---\nPROJECT BODY");

  const agent = createLiteAgent({ model: callTool("load_skill", { name: "demo" }), workdir });
  const res = await toolResults(agent);
  expect(res).toContain("PROJECT BODY");
  expect(res).not.toContain("GLOBAL BODY");
});

test("compactor:false disables the reactive net (prompt_too_long is not recovered)", async () => {
  let calls = 0;
  const provider = {
    id: "ov",
    async *stream() {
      calls++;
      if (calls === 1) throw new ProviderError("prompt is too long", 413);
      yield {
        type: "message_done",
        message: { role: "assistant", content: [textBlock("ok")] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  const turn = (i: number): Message[] => [
    { role: "user", content: `q${i}` },
    { role: "assistant", content: [{ type: "tool_call", id: `c${i}`, name: "f", input: {} }] },
    { role: "user", content: [{ type: "tool_result", id: `c${i}`, content: `r${i}` }] },
  ];
  const history = [0, 1, 2].flatMap(turn);
  const agent = createLiteAgent({ model: provider as any, workdir: freshWorkdir(), compactor: false });
  await expect(agent.send(history)).rejects.toThrow(/prompt is too long/);
  expect(calls).toBe(1);
});

test("cleanup default removes a stale file; cleanup:false keeps it", async () => {
  const stale = (sub: string) => {
    const dir = join(home(), "projects", "deadbeefdeadbeef", sub);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, "old.jsonl");
    writeFileSync(fp, "x");
    const when = (Date.now() - 40 * 86_400_000) / 1000;
    utimesSync(fp, when, when);
    return fp;
  };

  const kept = stale("sessions");
  createLiteAgent({ model: sayOk(), workdir: freshWorkdir(), cleanup: false });
  expect(existsSync(kept)).toBe(true);

  const swept = stale("spill");
  createLiteAgent({ model: sayOk(), workdir: freshWorkdir() });
  expect(existsSync(swept)).toBe(false);
});
