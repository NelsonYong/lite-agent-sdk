import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, policy, textBlock, memoryCheckpointer } from "@lite-agent/core";
import type { AgentEvent, ToolCall } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

afterEach(() => vi.unstubAllEnvs());
const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
const node = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;
const marker = (value: string) => node(`require('node:fs').appendFileSync('order.txt', ${JSON.stringify(value + "\n")})`);
function setup() {
  const workdir = mkdtempSync(join(tmpdir(), "hook-files-"));
  const home = join(workdir, "test-home");
  mkdirSync(home);
  mkdirSync(join(workdir, ".lite-agent"));
  const global = join(home, "hooks.json"), project = join(workdir, ".lite-agent", "hooks.json");
  const write = (path: string, hooks: unknown) => writeFileSync(path, JSON.stringify({ version: 1, hooks }));
  const model = fakeProvider([{ message: { role: "assistant", content: [textBlock("ok")] } }]);
  return { global, project, write, workdir, config: { model, workdir, home, sessions: false, tasks: false, agents: false, cleanup: false } };
}

test("global/project arrays append in order before programmatic handlers, and commands use the sandbox", async () => {
  const s = setup();
  s.write(s.global, { "run:end": [{ command: marker("global1") }, { command: marker("global2") }] });
  s.write(s.project, { "run:end": [{ command: marker("project") }] });
  const wrap = vi.fn(async (command: string) => command);
  const agent = createLiteAgent({ ...s.config, permission: policy({ allow: ["hook"], default: "deny" }), sandbox: { id: "test", wrap } });
  agent.hook("run:end", () => { appendFileSync(join(s.workdir, "order.txt"), "programmatic\n"); });
  await agent.send("go");
  expect(readFileSync(join(s.workdir, "order.txt"), "utf8")).toBe("global1\nglobal2\nproject\nprogrammatic\n");
  expect(wrap).toHaveBeenCalledTimes(3);
  expect(wrap.mock.calls[0]?.[0]).toContain(process.execPath);
  await agent.close();
});

test("JSON hooks require permission and a deny cannot be overridden by an approval handler", async () => {
  const s = setup();
  s.write(s.project, { "run:start": [{ command: marker("unsafe") }] });
  for (const explicitDeny of [false, true]) {
    const approval = vi.fn(async (_call: ToolCall) => "allow" as const);
    const agent = createLiteAgent({ ...s.config, ...(explicitDeny ? { permission: policy({ deny: ["hook"] }), onApproval: { request: approval } } : {}) });
    const events: AgentEvent[] = [];
    agent.subscribe(({ event }) => events.push(event));
    expect((await agent.send("go")).text).toBe("ok");
    expect(existsSync(join(s.workdir, "order.txt"))).toBe(false);
    expect(approval).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "diagnostic", code: "hook_failed" }));
    await agent.close();
  }
});

test("default hook approval receives the exact command, source, and event", async () => {
  const s = setup();
  const command = marker("approved");
  s.write(s.project, { "run:end": [{ command }] });
  const approval = vi.fn(async (_call: ToolCall) => "allow" as const);
  const agent = createLiteAgent({ ...s.config, onApproval: { request: approval } });
  await agent.send("go");
  expect(approval.mock.calls[0]?.[0]).toMatchObject({ name: "hook", input: { command, source: "project", event: "run:end", configFile: s.project } });
  expect(readFileSync(join(s.workdir, "order.txt"), "utf8")).toBe("approved\n");
  await agent.close();
});

test("payload travels through stdin without interpolation or inherited credentials", async () => {
  const s = setup();
  vi.stubEnv("HOOK_TEST_SECRET", "must-not-be-inherited");
  s.write(s.project, { "run:start": [{ command: node("const fs=require('node:fs'); const event=JSON.parse(fs.readFileSync(0,'utf8')); fs.writeFileSync('payload.json', JSON.stringify({input:event.input,secret:process.env.HOOK_TEST_SECRET??null}))") }] });
  const agent = createLiteAgent({ ...s.config, permission: policy({ allow: ["hook"] }) });
  const prompt = "$(touch injected.txt); ' quoted input";
  await agent.send(prompt);
  expect(JSON.parse(readFileSync(join(s.workdir, "payload.json"), "utf8"))).toEqual({ input: prompt, secret: null });
  expect(existsSync(join(s.workdir, "injected.txt"))).toBe(false);
  await agent.close();
});

test("nonzero exits, timeout and excessive output are separate diagnostics and later hooks still run", async () => {
  const s = setup();
  s.write(s.project, { "run:end": [
    { command: node("process.exit(7)") },
    { command: node("setTimeout(()=>require('node:fs').writeFileSync('late.txt','bad'), 1000)"), timeoutMs: 30 },
    { command: node("process.stdout.write('x'.repeat(100000))") },
    { command: marker("continued") },
  ] });
  const agent = createLiteAgent({ ...s.config, permission: policy({ allow: ["hook"] }) });
  const events: AgentEvent[] = [];
  agent.subscribe(({ event }) => events.push(event));
  expect((await agent.send("go")).text).toBe("ok");
  expect(events.filter((event) => event.type === "diagnostic" && event.code === "hook_failed")).toHaveLength(3);
  expect(readFileSync(join(s.workdir, "order.txt"), "utf8")).toBe("continued\n");
  expect(existsSync(join(s.workdir, "late.txt"))).toBe(false);
  await agent.close();
});

test("configuration changes do not hot-load executable hooks into a running agent", async () => {
  const s = setup();
  s.write(s.project, { "run:end": [{ command: marker("original") }] });
  const agent = createLiteAgent({ ...s.config, permission: policy({ allow: ["hook"] }) });
  s.write(s.project, { "run:end": [{ command: marker("changed") }] });
  await agent.send("go");
  expect(readFileSync(join(s.workdir, "order.txt"), "utf8")).toBe("original\n");
  await agent.close();
});

test("malformed configurations fail at startup and hookFiles:false disables discovery only", async () => {
  const s = setup();
  s.write(s.project, { "typo:event": [{ command: marker("wrong") }] });
  expect(() => createLiteAgent(s.config)).toThrow(/Invalid hooks configuration/);
  const agent = createLiteAgent({ ...s.config, hookFiles: false });
  let called = false;
  agent.hook("run:end", () => { called = true; });
  await agent.send("go");
  expect(called).toBe(true);
  expect(existsSync(join(s.workdir, "order.txt"))).toBe(false);
  await agent.close();
});

test("automatic compaction command hooks are audited without conflicting with the context engine", async () => {
  const s = setup(), cp = memoryCheckpointer();
  s.write(s.project, { "compact:start": [{ command: marker("start") }], "compact:end": [{ command: marker("end") }] });
  const agent = createLiteAgent({ ...s.config,
    model: { ...s.config.model, context: { contextWindow: 100, countTokens: async () => 80 } },
    checkpointer: cp, permission: policy({ allow: ["hook"] }), permissionAudit: true,
  });
  expect((await agent.send("go")).text).toBe("ok");
  expect(readFileSync(join(s.workdir, "order.txt"), "utf8")).toBe("start\nend\n");
  const decisions = [];
  for await (const entry of cp.read(agent.sessionId)) if (entry.event.type === "permission_decision") decisions.push(entry.event);
  expect(decisions).toHaveLength(2);
  expect(decisions.every((event) => event.call.name === "hook" && event.decision === "allow")).toBe(true);
  await agent.close();
});

test("tool-name match runs only matching commands", async () => {
  const s = setup();
  writeFileSync(join(s.workdir, "input.txt"), "data");
  s.write(s.project, { "tool:end": [
    { match: "write_*", command: marker("write") },
    { match: "read_*", command: marker("read") },
  ] });
  const agent = createLiteAgent({ ...s.config, permission: policy({ allow: ["hook", "read_file"], default: "deny" }),
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "r", name: "read_file", input: { path: "input.txt" } }] } },
      { message: { role: "assistant", content: [textBlock("ok")] } },
    ]),
  });
  await agent.send("read");
  expect(readFileSync(join(s.workdir, "order.txt"), "utf8")).toBe("read\n");
  await agent.close();
});
