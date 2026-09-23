import { expect, test } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, memoryCheckpointer, textBlock } from "@lite-agent/core";
import type { AgentEvent, ModelProvider } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { fileContextArchive } from "../src/contextArchive";
import { resolveProjectPaths, sessionContextDir } from "../src/paths";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}
const directory = () => mkdtempSync(join(tmpdir(), "lifecycle-safety-"));
const reply = () => fakeProvider([{ message: { role: "assistant", content: [textBlock("ok")] } }]);

test("close aborts an active foreground provider and rejects later runs", async () => {
  const entered = deferred();
  let signal: AbortSignal | undefined;
  const model: ModelProvider = { id: "waiting", async *stream(_, suppliedSignal) {
    signal = suppliedSignal;
    entered.resolve();
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    yield { type: "message_done", message: { role: "assistant", content: [] }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const agent = createLiteAgent({ model, workdir: directory(), sessions: false, tasks: false, agents: false });
  const running = agent.send("wait");
  await entered.promise;
  await expect(agent.compact().next()).rejects.toThrow(/busy/);
  await agent.close();
  expect(signal?.aborted).toBe(true);
  await running;
  await expect(agent.send("late")).rejects.toThrow(/closed/);
});

test("close cancels a pending human input request", async () => {
  const entered = deferred();
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "q", name: "ask_user", input: { question: "continue?" } }] } },
      { message: { role: "assistant", content: [textBlock("done")] } },
    ]), workdir: directory(), tasks: false, agents: false,
    onAskUser: { request: () => { entered.resolve(); return new Promise(() => {}); } },
  });
  const running = agent.send("ask");
  await entered.promise;
  await agent.close();
  await running;
});

test("close releases a stream suspended at a yield", async () => {
  const agent = createLiteAgent({ model: reply(), workdir: directory(), sessions: false });
  const stream = agent.run("hello");
  expect((await stream.next()).done).toBe(false);
  await agent.close();
  expect((await stream.next()).done).toBe(true);
});

test("closing during approval cannot execute a late-approved write", async () => {
  const workdir = directory(), entered = deferred();
  let approve!: (decision: "allow") => void;
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "w", name: "write_file", input: { path: "late.txt", content: "bad" } }] } },
      { message: { role: "assistant", content: [textBlock("done")] } },
    ]), workdir, tasks: false, agents: false,
    onApproval: { request: () => new Promise<"allow">((resolve) => { approve = resolve; entered.resolve(); }) },
  });
  const running = agent.send("write");
  await entered.promise;
  await agent.close();
  approve("allow");
  await running;
  expect(existsSync(join(workdir, "late.txt"))).toBe(false);
});

test("cancelled compaction publishes its terminal state without committing a new view", async () => {
  const entered = deferred(), finish = deferred(), cp = memoryCheckpointer();
  const planner: ModelProvider = { id: "slow-planner", async *stream() {
    entered.resolve(); await finish.promise;
    yield { type: "message_done", message: { role: "assistant", content: [textBlock('{"segments":[]}')] }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const agent = createLiteAgent({ model: reply(), workdir: directory(), checkpointer: cp, context: { planner: { provider: planner, model: "planner" } } });
  await agent.send("preserve this");
  const head = await cp.head(agent.sessionId);
  const events: AgentEvent[] = [];
  agent.subscribe(({ event }) => events.push(event));
  const controller = new AbortController();
  const compacting = (async () => { for await (const _ of agent.compact(undefined, { signal: controller.signal })) { /* drain */ } })();
  const rejected = expect(compacting).rejects.toThrow();
  await entered.promise;
  controller.abort();
  await rejected;
  finish.resolve();
  expect(events).toContainEqual(expect.objectContaining({ type: "compaction", phase: "cancelled" }));
  expect(await cp.head(agent.sessionId)).toBe(head);
  await agent.close();
});

test("deleting a session removes its own archive without deleting another session", async () => {
  const workdir = directory(), home = directory();
  const agent = createLiteAgent({ model: reply(), workdir, home });
  await agent.send("hello");
  const { sessionsDir } = resolveProjectPaths({ workdir, home });
  const own = sessionContextDir(sessionsDir, agent.sessionId), other = sessionContextDir(sessionsDir, "other");
  fileContextArchive({ dir: own }).put("own data");
  fileContextArchive({ dir: other }).put("other data");
  await agent.deleteSession(agent.sessionId);
  expect(existsSync(own)).toBe(false);
  expect(existsSync(other)).toBe(true);
  await agent.close();
});
