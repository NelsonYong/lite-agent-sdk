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

test("update changes status and merges metadata", async () => {
  const s = newStore();
  await s.create({ subject: "x", description: "d" });
  const t = await s.update({ taskId: "1", status: "in_progress", metadata: { k: 1 } });
  expect(t.status).toBe("in_progress");
  expect(t.metadata).toEqual({ k: 1 });
  expect(s.get("1")?.status).toBe("in_progress");
});

test("addBlockedBy maintains both sides of the dependency", async () => {
  const s = newStore();
  await s.create({ subject: "a", description: "d" }); // #1
  await s.create({ subject: "b", description: "d" }); // #2
  await s.update({ taskId: "2", addBlockedBy: ["1"] });
  expect(s.get("2")?.blockedBy).toEqual(["1"]);
  expect(s.get("1")?.blocks).toEqual(["2"]);
});

test("update on an unknown task id throws", async () => {
  await expect(newStore().update({ taskId: "99", status: "completed" })).rejects.toThrow(/no task/);
});

test("a dependency edge that would create a cycle is rejected", async () => {
  const s = newStore();
  await s.create({ subject: "a", description: "d" }); // #1
  await s.create({ subject: "b", description: "d" }); // #2
  await s.update({ taskId: "2", addBlockedBy: ["1"] });          // 2 waits for 1
  await expect(s.update({ taskId: "1", addBlockedBy: ["2"] }))   // 1 waits for 2 → cycle
    .rejects.toThrow(/cycle/);
  expect(s.get("1")?.blockedBy).toEqual([]); // rejected → no partial write
});

test("addBlocks maintains both sides of the dependency", async () => {
  const s = newStore();
  await s.create({ subject: "a", description: "d" }); // #1
  await s.create({ subject: "b", description: "d" }); // #2
  await s.update({ taskId: "1", addBlocks: ["2"] });
  expect(s.get("1")?.blocks).toEqual(["2"]);
  expect(s.get("2")?.blockedBy).toEqual(["1"]);
});

test("a rejected cycle update writes neither side to disk", async () => {
  const s = newStore();
  await s.create({ subject: "a", description: "d" }); // #1
  await s.create({ subject: "b", description: "d" }); // #2
  await s.update({ taskId: "2", addBlockedBy: ["1"] });        // 2 waits for 1
  await expect(s.update({ taskId: "1", addBlockedBy: ["2"] })).rejects.toThrow(/cycle/);
  expect(s.get("1")?.blockedBy).toEqual([]);   // primary side not written
  expect(s.get("2")?.blocks).toEqual([]);      // counter side not written either (no partial write)
});

test("concurrent creates on the same dir get distinct ids (lock works)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-"));
  const a = fileTaskStore({ dir, listId: "default" });
  const b = fileTaskStore({ dir, listId: "default" });
  const results = await Promise.all([
    a.create({ subject: "from-a", description: "d" }),
    b.create({ subject: "from-b", description: "d" }),
  ]);
  expect(new Set(results.map((t) => t.id)).size).toBe(2);
  expect(a.list().length).toBe(2);
});
