import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { resolveProjectPaths } from "../src/paths";

const wd = () => mkdtempSync(join(tmpdir(), "cw-"));
const drainRun = async (agent: ReturnType<typeof createLiteAgent>, input: string) => {
  const gen = agent.run(input);
  let g = await gen.next();
  while (!g.done) g = await gen.next();
};

test("default persistence writes an event-format log", async () => {
  const w = wd();
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const fp = fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]);
  const agent = createLiteAgent({ model: fp, workdir: w, home });
  const sid = agent.sessionId;
  await drainRun(agent, "hello");
  const { sessionsDir } = resolveProjectPaths({ workdir: w, home });
  const files = readdirSync(sessionsDir);
  expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);
  const body = readFileSync(join(sessionsDir, `${sid}.jsonl`), "utf8");
  expect(body).toContain('"seq":1'); // StoredEvent shape, not a bare Message
  expect(body).toContain('"type":"user"');
});

test("listSessions/deleteSession work through the checkpointer", async () => {
  const w = wd();
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const fp = fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]);
  const agent = createLiteAgent({ model: fp, workdir: w, home });
  const sid = agent.sessionId;
  await drainRun(agent, "hi");
  expect((await agent.listSessions()).some((s) => s.id === sid)).toBe(true);
  await agent.deleteSession(sid);
  expect((await agent.listSessions()).some((s) => s.id === sid)).toBe(false);
});
