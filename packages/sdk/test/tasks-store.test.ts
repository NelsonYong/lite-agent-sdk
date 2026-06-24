import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTaskStore } from "../src/tasks/store";

const newStore = () =>
  fileTaskStore({ dir: mkdtempSync(join(tmpdir(), "tasks-")), listId: "default" });

test("create allocates sequential ids and get/list read them back", async () => {
  const s = newStore();
  const a = await s.create({ subject: "first", description: "d1" });
  const b = await s.create({ subject: "second", description: "d2" });
  expect([a.id, b.id]).toEqual(["1", "2"]);
  expect(a.status).toBe("pending");
  expect(s.get("1")?.subject).toBe("first");
  expect(s.list().map((t) => t.id)).toEqual(["1", "2"]);
});

test("get returns null for an unknown id", async () => {
  expect(newStore().get("99")).toBeNull();
});

test("tasks persist across store instances on the same dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-"));
  await fileTaskStore({ dir, listId: "default" }).create({ subject: "kept", description: "d" });
  expect(fileTaskStore({ dir, listId: "default" }).get("1")?.subject).toBe("kept");
});

test("render shows a marker + status per task and empty string for none", async () => {
  const s = newStore();
  expect(s.render()).toBe("");
  await s.create({ subject: "build it", description: "d" });
  expect(s.render()).toContain("[ ] #1 build it (pending)");
});

test("get sanitizes the id so it cannot traverse outside the list dir", () => {
  const parent = mkdtempSync(join(tmpdir(), "tasks-"));
  mkdirSync(join(parent, "default"), { recursive: true });
  // A file OUTSIDE the list dir that an unsanitized "../secret" id would resolve to.
  writeFileSync(join(parent, "secret.json"), JSON.stringify({ id: "x", subject: "SECRET" }));
  const s = fileTaskStore({ dir: parent, listId: "default" });
  expect(s.get("../secret")).toBeNull();
});
