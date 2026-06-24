import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, Message, ModelChunk } from "@lite-agent/core";
import { fileTaskStore } from "../src/tasks/store";
import { taskReminder } from "../src/tasks/reminder";

const mkCtx = (messages: Message[]): AgentContext =>
  ({ sessionId: "s", messages, turn: 1, signal: new AbortController().signal, emit: () => {}, state: new Map() });

const done: ModelChunk = {
  type: "message_done",
  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  usage: { inputTokens: 0, outputTokens: 0 },
};

async function drive(mw: ReturnType<typeof taskReminder>, ctx: AgentContext) {
  let seen: Message[] = [];
  const next = async function* () {
    seen = [...ctx.messages]; // what encode would see
    yield done;
  };
  for await (const _ of mw.wrapModelCall!(ctx, next)) { /* consume */ }
  return seen;
}

test("injects the task list into the model's view but restores ctx.messages after", async () => {
  const store = fileTaskStore({ dir: mkdtempSync(join(tmpdir(), "rem-")), listId: "default" });
  await store.create({ subject: "do thing", description: "d" });
  const ctx = mkCtx([{ role: "user", content: "hi" }]);

  const seen = await drive(taskReminder(store), ctx);

  expect(seen.some((m) => String(m.content).includes("<system-reminder>"))).toBe(true);
  expect(seen.some((m) => String(m.content).includes("do thing"))).toBe(true);
  expect(ctx.messages).toHaveLength(1); // restored — reminder never lands in the transcript
});

test("does not inject anything when the task list is empty", async () => {
  const store = fileTaskStore({ dir: mkdtempSync(join(tmpdir(), "rem-")), listId: "default" });
  const ctx = mkCtx([{ role: "user", content: "hi" }]);
  const seen = await drive(taskReminder(store), ctx);
  expect(seen.some((m) => String(m.content).includes("system-reminder"))).toBe(false);
});

test("restores ctx.messages even when next() throws", async () => {
  const store = fileTaskStore({ dir: mkdtempSync(join(tmpdir(), "rem-")), listId: "default" });
  await store.create({ subject: "x", description: "d" });
  const ctx = mkCtx([{ role: "user", content: "hi" }]);
  const mw = taskReminder(store);
  const failing = async function* (): AsyncIterable<ModelChunk> { throw new Error("provider exploded"); };
  await expect(
    (async () => { for await (const _ of mw.wrapModelCall!(ctx, failing)) { /* consume */ } })(),
  ).rejects.toThrow("provider exploded");
  expect(ctx.messages).toHaveLength(1); // restored despite the throw
});
