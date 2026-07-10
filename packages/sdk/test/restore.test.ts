import { expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock, memoryCheckpointer } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

test("restore reverts a file written via write_file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-restore-"));
  const cp = memoryCheckpointer();
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "write_file", input: { path: "f.txt", content: "v1" } }] } },
      { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    workdir: dir,
    checkpointer: cp,
  });
  const id = agent.sessionId;
  await agent.send("write it");
  expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("v1");

  await agent.restore(id, 0, { files: true, conversation: false });
  expect(existsSync(join(dir, "f.txt"))).toBe(false);
});

test("restore recreates a file deleted via delete_file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-restore-delete-"));
  const cp = memoryCheckpointer();
  writeFileSync(join(dir, "f.txt"), "before delete");
  const agent = createLiteAgent({
    model: fakeProvider([
      { message: { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "delete_file", input: { path: "f.txt" } }] } },
      { text: "done", message: { role: "assistant", content: [textBlock("done")] } },
    ]),
    workdir: dir,
    checkpointer: cp,
  });
  const id = agent.sessionId;

  await agent.send("delete it");
  expect(existsSync(join(dir, "f.txt"))).toBe(false);

  await agent.restore(id, 0, { files: true, conversation: false });
  expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("before delete");
});

test("restore can truncate the conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-restore2-"));
  const cp = memoryCheckpointer();
  const agent = createLiteAgent({
    model: fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]),
    workdir: dir,
    checkpointer: cp,
  });
  const id = agent.sessionId;
  await agent.send("first");
  const cps = await agent.listCheckpoints(id);
  expect(cps.length).toBe(1);
  expect(cps[0]!.prompt).toBe("first");

  await agent.restore(id, 1, { conversation: true, files: false });
  const seen: number[] = [];
  for await (const e of cp.read(id)) seen.push(e.seq);
  expect(seen).toEqual([1]);
});
