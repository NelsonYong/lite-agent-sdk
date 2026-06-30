import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, textBlock, memoryCheckpointer } from "@lite-agent/core";
import type { Message, CompactResult } from "@lite-agent/core";
import { createLiteAgent } from "../src/createLiteAgent";

test("compact() compresses, persists a summary, notifies, and stops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-compact-"));
  const cp = memoryCheckpointer();
  const compactor = {
    async maybeCompact(): Promise<CompactResult> {
      return { messages: [{ role: "user", content: "SUMMARY" } as Message] };
    },
  };
  const agent = createLiteAgent({
    model: fakeProvider([{ text: "hi", message: { role: "assistant", content: [textBlock("hi")] } }]),
    workdir: dir, checkpointer: cp, compactor,
  });
  const id = agent.sessionId;
  await agent.send("hello there");

  const events = [];
  for await (const e of agent.compact()) events.push(e);

  expect(events.every((e) => e.type === "compaction" && e.kind === "manual")).toBe(true);
  expect(events.some((e) => e.type === "compaction" && e.phase === "done")).toBe(true);

  const stored = [];
  for await (const e of cp.read(id)) stored.push(e.event);
  expect(stored.some((e) => e.type === "summary")).toBe(true);
  const summary = stored.find((e) => e.type === "summary")!;
  expect(summary).toMatchObject({ type: "summary", messages: [{ role: "user", content: "SUMMARY" }] });
});
