import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, memoryCheckpointer, textBlock } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

const reply = () => fakeProvider([{ message: { role: "assistant", content: [textBlock("done")] } }]);
const root = () => mkdtempSync(join(tmpdir(), "checkpoint-safety-"));

test("checkpoint anchors cover block prompts and exclude internal/background messages", async () => {
  const cp = memoryCheckpointer();
  const agent = createLiteAgent({ model: reply(), workdir: root(), checkpointer: cp });
  await agent.send([{ role: "user", content: [textBlock("real prompt")] }]);
  await cp.append(agent.sessionId, [
    { type: "user", origin: "background", checkpoint: false, message: { role: "user", content: "completion" } },
    { type: "user", origin: "internal", checkpoint: false, message: { role: "user", content: "repair" } },
  ]);
  expect(await agent.listCheckpoints(agent.sessionId)).toEqual([
    expect.objectContaining({ seq: 0, prompt: "real prompt", files: [], unavailableFiles: [] }),
  ]);
  await agent.close();
});

test("restore preflights all paths and snapshots before changing files or conversation", async () => {
  const workdir = root(), cp = memoryCheckpointer();
  const agent = createLiteAgent({ model: reply(), workdir, checkpointer: cp });
  await agent.send("work");
  writeFileSync(join(workdir, "a.txt"), "current");
  await cp.append(agent.sessionId, [
    { type: "file_snapshot", path: "a.txt", before: "old", turn: 1 },
    { type: "file_snapshot", path: "large.bin", before: null, truncated: true, turn: 1 },
  ]);
  const head = await cp.head(agent.sessionId);
  const checkpoints = await agent.listCheckpoints(agent.sessionId);
  expect(checkpoints[0]?.unavailableFiles).toEqual(["large.bin"]);
  await expect(agent.restore(agent.sessionId, 0)).rejects.toThrow(/truncated/);
  expect(readFileSync(join(workdir, "a.txt"), "utf8")).toBe("current");
  expect(await cp.head(agent.sessionId)).toBe(head);
  await expect(agent.restore(agent.sessionId, -1)).rejects.toThrow(/sequence/);
  await expect(agent.restore(agent.sessionId, head + 1)).rejects.toThrow(/sequence/);
  await agent.close();
});

test("a failed truncate restores the original file contents", async () => {
  const workdir = root(), cp = memoryCheckpointer();
  const agent = createLiteAgent({ model: reply(), workdir, checkpointer: { ...cp, async truncate() { throw new Error("storage unavailable"); } } });
  await agent.send("work");
  writeFileSync(join(workdir, "a.txt"), "current");
  await cp.append(agent.sessionId, [{ type: "file_snapshot", path: "a.txt", before: "old", turn: 1 }]);
  await expect(agent.restore(agent.sessionId, 0)).rejects.toThrow("storage unavailable");
  expect(readFileSync(join(workdir, "a.txt"), "utf8")).toBe("current");
  expect(await cp.head(agent.sessionId)).toBe(3);
  await agent.send("still usable");
  await agent.close();
});

test("conversation rewind cannot split an assistant tool call from its result", async () => {
  const cp = memoryCheckpointer();
  const agent = createLiteAgent({ model: reply(), workdir: root(), checkpointer: cp });
  await cp.append(agent.sessionId, [
    { type: "user", checkpoint: true, origin: "user", message: { role: "user", content: "work" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_call", id: "t", name: "read_file", input: { path: "a" } }] } },
    { type: "tool_result", result: { type: "tool_result", id: "t", content: "result" }, turn: 1 },
  ]);
  await expect(agent.restore(agent.sessionId, 2)).rejects.toThrow(/unfinished tool calls/);
  expect(await cp.head(agent.sessionId)).toBe(3);
  await agent.restore(agent.sessionId, 0);
  await agent.restore(agent.sessionId, 0);
  expect(await cp.head(agent.sessionId)).toBe(0);
  await agent.close();
});

test("restore refuses to overwrite a file edited outside the recorded agent operation", async () => {
  const workdir = root(), cp = memoryCheckpointer();
  writeFileSync(join(workdir, "a.txt"), "before");
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "w", name: "write_file", input: { path: "a.txt", content: "agent edit" } }] } },
      { message: { role: "assistant", content: [textBlock("done")] } },
    ]), workdir, checkpointer: cp, onApproval: { request: async () => "allow" },
  });
  await agent.send("edit");
  writeFileSync(join(workdir, "a.txt"), "user edit");
  await expect(agent.restore(agent.sessionId, 0)).rejects.toThrow(/outside the recorded operation/);
  expect(readFileSync(join(workdir, "a.txt"), "utf8")).toBe("user edit");
  await agent.restore(agent.sessionId, 0, { files: false });
  expect(readFileSync(join(workdir, "a.txt"), "utf8")).toBe("user edit");
  await agent.close();
});
