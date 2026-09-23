import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, memoryCheckpointer, textBlock } from "@lite-agent/core";
import type { AgentEvent, ModelProvider } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";
import { fileContextArchive } from "../src/contextArchive";
import { resolveProjectPaths, sessionContextDir } from "../src/paths";

const directory = () => realpathSync(mkdtempSync(join(tmpdir(), "context-operation-")));
const reply = () => fakeProvider([{ message: { role: "assistant", content: [textBlock("ok")] } }]);

test("manual compaction publishes live stages to subscribers and commits only after planning", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const planner: ModelProvider = { id: "planner", async *stream() {
    await waiting;
    yield { type: "message_done", message: { role: "assistant", content: [textBlock('{"segments":[]}')] }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const cp = memoryCheckpointer();
  const agent = createLiteAgent({ model: reply(), workdir: directory(), checkpointer: cp, context: { planner: { provider: planner, model: "planner" } } });
  await agent.send("Goal: retain this request");
  const before = await cp.head(agent.sessionId);
  const observed: AgentEvent[] = [];
  agent.subscribe(({ event }) => observed.push(event));
  const stream = agent.compact();
  let next = await stream.next();
  expect(next.value).toMatchObject({ type: "compaction", phase: "start", stage: "measure" });
  while (!next.done && !(next.value.type === "compaction" && next.value.stage === "summarize")) next = await stream.next();
  expect(observed).toContainEqual(expect.objectContaining({ type: "compaction", phase: "progress", stage: "summarize" }));
  expect(await cp.head(agent.sessionId)).toBe(before);
  release();
  while (!next.done) next = await stream.next();
  expect(observed.at(-1)).toMatchObject({ type: "compaction", phase: "done" });
  expect(await cp.head(agent.sessionId)).toBeGreaterThan(before);
  await agent.close();
});

test("large file contents are archived intact before truncation and only references reach the model", async () => {
  const workdir = directory(), home = directory();
  const content = `${"payload界".repeat(20_000)}END_MARKER`;
  writeFileSync(join(workdir, "large.txt"), content);
  const seen: string[] = [];
  let turn = 0;
  const model: ModelProvider = { id: "large-file", async *stream(request) {
    seen.push(JSON.stringify(request.messages));
    yield { type: "message_done", message: { role: "assistant", content: turn++ === 0
      ? [{ type: "tool_call", id: "read", name: "read_file", input: { path: "large.txt" } }]
      : [textBlock("done")] }, usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const agent = createLiteAgent({ model, workdir, home, tasks: false, agents: false });
  const result = await agent.send("Read the large file");
  expect(seen[1]!.length).toBeLessThan(3000);
  expect(seen[1]).toContain("tool result archived:");
  expect(seen[1]).not.toContain("END_MARKER");
  const ref = JSON.stringify(result.messages).match(/archived: ([a-f0-9]{64})/)![1]!;
  const { sessionsDir } = resolveProjectPaths({ workdir, home });
  const archiveDir = sessionContextDir(sessionsDir, agent.sessionId);
  expect(readFileSync(join(archiveDir, "notes", `${ref}.md`), "utf8")).toBe(content);
  const archive = fileContextArchive({ dir: archiveDir });
  expect(archive.read(ref, 1, { offset: content.length - 10 })).toContain("END_MARKER");
  expect(fileContextArchive({ dir: join(home, "another-session") }).read(ref, 1)).toContain("No archived content");
  await agent.close();
});

test("archive pages preserve Unicode, reject path refs and refuse symlink substitution", () => {
  const dir = directory();
  const archive = fileContextArchive({ dir, maxReadBytes: 512 });
  const content = "界😀<&>".repeat(200);
  const { ref } = archive.put(content);
  let offset = 0, pages = 0;
  while (offset < content.length) {
    const page = archive.read(ref, ++pages, { offset });
    expect(Buffer.byteLength(page)).toBeLessThanOrEqual(512);
    expect(page).not.toContain("�");
    const next = page.match(/nextOffset=(\d+|end)/)![1]!;
    if (next === "end") break;
    expect(Number(next)).toBeGreaterThan(offset);
    offset = Number(next);
  }
  expect(pages).toBeGreaterThan(1);
  expect(archive.read("../../secret", pages + 1)).toContain("No archived content");
  const outside = join(directory(), "secret");
  writeFileSync(outside, "PRIVATE_MARKER");
  const badRef = "a".repeat(64);
  symlinkSync(outside, join(dir, "notes", `${badRef}.md`));
  writeFileSync(join(dir, "index.jsonl"), `${JSON.stringify({ ref: badRef, preview: "alias" })}\n`);
  expect(() => archive.read(badRef, pages + 2)).toThrow(/Symlink/);
});

test("SDK-owned session data is readable outside the project but other sessions and arbitrary paths are not", async () => {
  const workdir = directory(), home = directory();
  const cp = memoryCheckpointer();
  const targets: string[] = [];
  let index = 0;
  const model: ModelProvider = { id: "storage", async *stream() {
    yield { type: "message_done", message: { role: "assistant", content: index < targets.length
      ? [{ type: "tool_call", id: `read-${index}`, name: "read_file", input: { path: targets[index++] } }]
      : [textBlock("done")] }, usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const agent = createLiteAgent({ model, workdir, home, checkpointer: cp, tasks: false, agents: false });
  const { sessionsDir } = resolveProjectPaths({ workdir, home });
  const ownDir = sessionContextDir(sessionsDir, agent.sessionId);
  const ownRef = fileContextArchive({ dir: ownDir }).put("OWN_MARKER").ref;
  const otherDir = sessionContextDir(sessionsDir, "other");
  const otherRef = fileContextArchive({ dir: otherDir }).put("OTHER_MARKER").ref;
  targets.push(join(ownDir, "notes", `${ownRef}.md`), join(otherDir, "notes", `${otherRef}.md`));
  const outputs: string[] = [];
  for await (const event of agent.run("Inspect SDK data")) if (event.type === "tool_result") outputs.push(event.result.content);
  expect(outputs[0]).toBe("OWN_MARKER");
  expect(outputs[1]).toContain("Error:");
  expect(outputs.join(" ")).not.toContain("OTHER_MARKER");
  expect(existsSync(ownDir)).toBe(true);
  await agent.close();
});
