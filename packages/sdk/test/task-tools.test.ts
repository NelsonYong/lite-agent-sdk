import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@lite-agent/core";
import { fileTaskStore } from "../src/tasks/store";
import { taskTools } from "../src/tools/task";

const ctx = { sessionId: "s", signal: new AbortController().signal, emit: () => {} } as ToolContext;
const tools = () => {
  const store = fileTaskStore({ dir: mkdtempSync(join(tmpdir(), "tt-")), listId: "default" });
  const map = new Map(taskTools(store).map((t) => [t.name, t]));
  return { store, map };
};

test("taskTools exposes the four tools by name", () => {
  expect([...tools().map.keys()].sort()).toEqual(["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
});

test("TaskCreate returns the new id; TaskList renders it", async () => {
  const { map } = tools();
  const created = await map.get("TaskCreate")!.execute({ subject: "build", description: "d" }, ctx);
  expect(created).toMatch(/#1/);
  const listed = await map.get("TaskList")!.execute({}, ctx);
  expect(listed).toContain("#1 build (pending)");
});

test("TaskUpdate advances status; TaskGet returns full detail", async () => {
  const { map } = tools();
  await map.get("TaskCreate")!.execute({ subject: "x", description: "d" }, ctx);
  await map.get("TaskUpdate")!.execute({ taskId: "1", status: "completed" }, ctx);
  const got = await map.get("TaskGet")!.execute({ taskId: "1" }, ctx);
  expect(got).toContain('"status": "completed"');
});

test("TaskGet on an unknown id reports it without throwing", async () => {
  const { map } = tools();
  expect(await map.get("TaskGet")!.execute({ taskId: "99" }, ctx)).toMatch(/No task/);
});
