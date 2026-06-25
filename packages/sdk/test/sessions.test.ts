import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock, memoryStore } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { jsonlStore } from "../src/store";

const freshDir = () => mkdtempSync(join(tmpdir(), "lite-sessions-"));
const reply = (text: string) =>
  fakeProvider([{ text, message: { role: "assistant", content: [textBlock(text)] } }]);

test("each agent gets a unique, non-counter default session id", () => {
  const mk = () => createLiteAgent({ model: reply("x"), workdir: process.cwd(), cleanup: false });
  const a = mk();
  const b = mk();
  expect(a.sessionId).not.toBe(b.sessionId);
  expect(a.sessionId).not.toMatch(/^s\d+$/); // not the old counter form
  expect(a.sessionId).toMatch(/^s-[0-9a-z]+-[0-9a-f]{6}$/);
});

test("resume(id) reconstructs an existing session's history", async () => {
  const dir = freshDir();
  const a1 = createLiteAgent({ model: reply("r1"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  await a1.send([{ role: "user", content: "first" }]);
  const id = a1.sessionId;

  const a2 = createLiteAgent({ model: reply("r2"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  a2.resume(id);
  const r = await a2.send([{ role: "user", content: "second" }]);
  expect(r.messages).toContainEqual({ role: "user", content: "first" });
  expect(r.messages).toContainEqual({ role: "user", content: "second" });
});

test("clear() rotates to a new session and keeps the old transcript", async () => {
  const dir = freshDir();
  const agent = createLiteAgent({
    model: fakeProvider([
      { text: "a", message: { role: "assistant", content: [textBlock("a")] } },
      { text: "b", message: { role: "assistant", content: [textBlock("b")] } },
    ]),
    workdir: process.cwd(),
    store: jsonlStore({ dir }),
    cleanup: false,
  });
  const id1 = agent.sessionId;
  await agent.send([{ role: "user", content: "first" }]);
  const id2 = agent.clear();
  expect(id2).not.toBe(id1);
  expect(agent.sessionId).toBe(id2);
  await agent.send([{ role: "user", content: "second" }]);
  const ids = (await agent.listSessions()).map((s) => s.id);
  expect(ids).toContain(id1); // old transcript still on disk
  expect(ids).toContain(id2);
});

test("deleteSession removes a transcript from listSessions", async () => {
  const dir = freshDir();
  const agent = createLiteAgent({ model: reply("a"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  const id = agent.sessionId;
  await agent.send([{ role: "user", content: "hi" }]);
  expect((await agent.listSessions()).map((s) => s.id)).toContain(id);
  await agent.deleteSession(id);
  expect((await agent.listSessions()).map((s) => s.id)).not.toContain(id);
});

test("session management throws when persistence is disabled", async () => {
  const agent = createLiteAgent({ model: reply("x"), workdir: process.cwd(), sessions: false, cleanup: false });
  await expect(agent.listSessions()).rejects.toThrow(/session-capable store/);
  await expect(agent.deleteSession("x")).rejects.toThrow(/session-capable store/);
});

test("session management throws with a store lacking list/delete", async () => {
  const agent = createLiteAgent({ model: reply("x"), workdir: process.cwd(), store: memoryStore(), cleanup: false });
  await expect(agent.listSessions()).rejects.toThrow(/session-capable store/);
});

test("a fresh agent over the same sessions dir does not resume a prior agent's session", async () => {
  const dir = freshDir();
  const a1 = createLiteAgent({ model: reply("r1"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  await a1.send([{ role: "user", content: "first" }]);
  // Simulates a process restart: new agent, new default id, same dir.
  const a2 = createLiteAgent({ model: reply("r2"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  const r = await a2.send([{ role: "user", content: "second" }]);
  expect(r.messages).not.toContainEqual({ role: "user", content: "first" });
  expect(r.messages).toContainEqual({ role: "user", content: "second" });
});

test("resume() to an unknown id starts an empty session (no carryover)", async () => {
  const dir = freshDir();
  const a1 = createLiteAgent({ model: reply("r1"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  await a1.send([{ role: "user", content: "first" }]);
  const a2 = createLiteAgent({ model: reply("r2"), workdir: process.cwd(), store: jsonlStore({ dir }), cleanup: false });
  a2.resume("does-not-exist");
  const r = await a2.send([{ role: "user", content: "second" }]);
  expect(r.messages).not.toContainEqual({ role: "user", content: "first" });
  expect(r.messages).toContainEqual({ role: "user", content: "second" });
});
