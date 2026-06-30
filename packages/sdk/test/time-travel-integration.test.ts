import { expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock, memoryCheckpointer } from "@lite-agent/core";
import type { ModelProvider, Message, FakeTurn, CompactResult } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

// A model provider that snapshots each call's messages (to assert what the model saw),
// delegating the actual stream to a scripted fakeProvider.
function recording(script: FakeTurn[]) {
  const seen: Message[][] = [];
  const inner = fakeProvider(script);
  const provider: ModelProvider = {
    id: "rec",
    stream: (req, signal) => {
      seen.push([...req.messages]);
      return inner.stream(req, signal);
    },
  };
  return { provider, seen };
}

test("restore truncates, then a subsequent run continues from the restored point", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-a-"));
  const cp = memoryCheckpointer();
  const { provider, seen } = recording([
    { text: "a1", message: { role: "assistant", content: [textBlock("a1")] } },
    { text: "a2", message: { role: "assistant", content: [textBlock("a2")] } },
    { text: "a3", message: { role: "assistant", content: [textBlock("a3")] } },
  ]);
  const agent = createLiteAgent({ model: provider, workdir: dir, checkpointer: cp });
  const id = agent.sessionId;
  await agent.send("first"); // user(1), assistant a1(2)
  await agent.send("second"); // user(3), assistant a2(4)
  await agent.restore(id, 2, { conversation: true, files: false }); // keep seq 1,2
  await agent.send("third"); // reload [first, a1] + user "third"

  // The log is contiguous again — truncate reset head so the new turn appends at 3,4
  // (no collision with the dropped "second" turn).
  const seqs: number[] = [];
  for await (const e of cp.read(id)) seqs.push(e.seq);
  expect(seqs).toEqual([1, 2, 3, 4]);

  // The third model call saw the restored history, not the dropped "second".
  const last = seen[seen.length - 1]!;
  expect(last.some((m) => m.role === "user" && m.content === "third")).toBe(true);
  expect(last.some((m) => m.role === "user" && m.content === "second")).toBe(false);
});

test("compact persists a summary that a subsequent run loads as the base", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-b-"));
  const cp = memoryCheckpointer();
  const { provider, seen } = recording([
    { text: "a1", message: { role: "assistant", content: [textBlock("a1")] } },
    { text: "a2", message: { role: "assistant", content: [textBlock("a2")] } },
  ]);
  // The configured compactor serves BOTH proactive per-turn compaction and manual
  // compact(). Keep it inert (returns the same array → middleware no-ops) except during
  // the explicit compact() call, gated by `active`.
  let active = false;
  const compactor = {
    async maybeCompact(messages: Message[]): Promise<CompactResult> {
      return active ? { messages: [{ role: "user", content: "SUMMARY" } as Message] } : { messages };
    },
  };
  const agent = createLiteAgent({ model: provider, workdir: dir, checkpointer: cp, compactor });
  const id = agent.sessionId;
  await agent.send("hello"); // user(1), assistant a1(2)
  active = true;
  const evs = [];
  for await (const e of agent.compact()) evs.push(e); // persists summary(3)
  active = false;
  await agent.send("next"); // reload base = SUMMARY + user "next"

  const last = seen[seen.length - 1]!;
  expect(last[0]).toEqual({ role: "user", content: "SUMMARY" });
  expect(last.some((m) => m.content === "next")).toBe(true);
  expect(last.some((m) => m.content === "hello")).toBe(false); // compacted away from the model's view
});

test("restore picks the earliest snapshot per path across multiple edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-c-"));
  const cp = memoryCheckpointer();
  const agent = createLiteAgent({
    model: fakeProvider([{ text: "x", message: { role: "assistant", content: [textBlock("x")] } }]),
    workdir: dir,
    checkpointer: cp,
  });
  writeFileSync(join(dir, "f.txt"), "v3");
  // three snapshots for the same path: created (null) → v1 → v2
  await cp.append("s1", [
    { type: "file_snapshot", path: "f.txt", before: null, turn: 1 },
    { type: "file_snapshot", path: "f.txt", before: "v1", turn: 2 },
    { type: "file_snapshot", path: "f.txt", before: "v2", turn: 3 },
  ]);

  // restore to seq 1: earliest snapshot with seq > 1 is before "v1"
  await agent.restore("s1", 1, { files: true, conversation: false });
  expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("v1");

  // restore to seq 0: earliest snapshot with seq > 0 is before null → delete
  await agent.restore("s1", 0, { files: true, conversation: false });
  expect(existsSync(join(dir, "f.txt"))).toBe(false);
});

test("listCheckpoints -> restore lands cleanly before the chosen prompt (no dangling turn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-d-"));
  const cp = memoryCheckpointer();
  const { provider, seen } = recording([
    { text: "a1", message: { role: "assistant", content: [textBlock("a1")] } },
    { text: "a2", message: { role: "assistant", content: [textBlock("a2")] } },
    { text: "a3", message: { role: "assistant", content: [textBlock("a3")] } },
  ]);
  const agent = createLiteAgent({ model: provider, workdir: dir, checkpointer: cp });
  const id = agent.sessionId;
  await agent.send("first"); // user(1), assistant a1(2)
  await agent.send("second"); // user(3), assistant a2(4)

  // Rewind to the "second" prompt by feeding its checkpoint seq straight to restore.
  const cps = await agent.listCheckpoints(id);
  const target = cps.find((c) => c.prompt === "second")!;
  await agent.restore(id, target.seq, { conversation: true, files: false });
  await agent.send("redo");

  // The redo model call must see [first, a1, redo] — the "second" prompt is fully undone,
  // no dangling unanswered prompt and no two consecutive user messages.
  const last = seen[seen.length - 1]!;
  const shape = last.map((m) => (typeof m.content === "string" ? m.content : "[assistant]"));
  expect(shape).toEqual(["first", "[assistant]", "redo"]);
});
