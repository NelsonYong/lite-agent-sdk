import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fakeProvider,
  memoryCheckpointer,
  memoryStore,
  textBlock,
} from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { jsonlStore } from "../src/store";

const freshDir = () => mkdtempSync(join(tmpdir(), "lite-sessions-"));
const freshWorkdir = () => mkdtempSync(join(tmpdir(), "lite-wd-"));
const reply = (text: string) =>
  fakeProvider([{ text, message: { role: "assistant", content: [textBlock(text)] } }]);

test("each agent gets a unique, non-counter default session id", () => {
  const mk = () => createLiteAgent({ model: reply("x"), workdir: process.cwd(), cleanup: false });
  const a = mk();
  const b = mk();
  expect(a.sessionId).not.toBe(b.sessionId);
  expect(a.sessionId).not.toMatch(/^s\d+$/); // not the old counter form
  expect(a.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
  // Default persistence (fileCheckpointer): list/delete are first-class on the Checkpointer.
  const agent = createLiteAgent({
    model: fakeProvider([
      { text: "a", message: { role: "assistant", content: [textBlock("a")] } },
      { text: "b", message: { role: "assistant", content: [textBlock("b")] } },
    ]),
    workdir: freshWorkdir(),
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
  // Default persistence (fileCheckpointer): list/delete are first-class on the Checkpointer.
  const agent = createLiteAgent({ model: reply("a"), workdir: freshWorkdir(), cleanup: false });
  const id = agent.sessionId;
  await agent.send([{ role: "user", content: "hi" }]);
  expect((await agent.listSessions()).map((s) => s.id)).toContain(id);
  await agent.deleteSession(id);
  expect((await agent.listSessions()).map((s) => s.id)).not.toContain(id);
});

test("session management throws when persistence is disabled", async () => {
  const agent = createLiteAgent({ model: reply("x"), workdir: process.cwd(), sessions: false, cleanup: false });
  await expect(agent.listSessions()).rejects.toThrow(/requires a checkpointer/);
  await expect(agent.deleteSession("x")).rejects.toThrow(/requires a checkpointer/);
});

test("a legacy store is adapted: listSessions returns [] (no enumeration) and delete no-ops", async () => {
  // A bare Store routes through legacyStoreAdapter, whose list/delete are degenerate
  // (it cannot enumerate) — so session management resolves degraded instead of throwing.
  const agent = createLiteAgent({ model: reply("x"), workdir: process.cwd(), store: memoryStore(), cleanup: false });
  expect(await agent.listSessions()).toEqual([]);
  await expect(agent.deleteSession("x")).resolves.toBeUndefined();
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

test("an injected session-capable store still drives listSessions/deleteSession", async () => {
  const storeDir = mkdtempSync(join(tmpdir(), "ls-store-"));
  const home = mkdtempSync(join(tmpdir(), "ls-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "ls-wd-"));
  const fp = fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]);
  const agent = createLiteAgent({ model: fp, workdir, home, cleanup: false, store: jsonlStore({ dir: storeDir }) });
  const sid = agent.sessionId;
  const gen = agent.run("hi");
  let g = await gen.next();
  while (!g.done) g = await gen.next();
  expect((await agent.listSessions()).some((s) => s.id === sid)).toBe(true);
  await agent.deleteSession(sid);
  expect((await agent.listSessions()).some((s) => s.id === sid)).toBe(false);
});

test("run captures the current session before its first next call", async () => {
  const checkpointer = memoryCheckpointer();
  const agent = createLiteAgent({
    model: reply("ok"),
    workdir: freshWorkdir(),
    checkpointer,
    cleanup: false,
    compactor: false,
  });
  agent.resume("captured-before-run");

  const run = agent.run("hello");
  agent.resume("selected-after-run");
  for await (const _event of run) {
    // Drain the run; the assertion is on the persisted session id.
  }

  expect(await checkpointer.head("captured-before-run")).toBe(2);
  expect(await checkpointer.head("selected-after-run")).toBe(0);
});

test("LiteAgent publishes user-run events through subscribe and rejects runs after close", async () => {
  const agent = createLiteAgent({
    model: reply("ok"),
    workdir: freshWorkdir(),
    sessions: false,
    cleanup: false,
  });
  const seen: string[] = [];
  const unsubscribe = agent.subscribe(({ sessionId, source, event }) => {
    if (event.type === "done") seen.push(`${sessionId}:${source}:${event.reason}`);
  });

  await agent.send("hello", { sessionId: "subscribed" });
  expect(seen).toEqual(["subscribed:user:stop"]);
  unsubscribe();
  await agent.close();
  await expect(agent.send("again")).rejects.toThrow("LiteAgent is closed");
});
