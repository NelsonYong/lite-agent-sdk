import { expect, test } from "vitest";
import { mkdtempSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonlStore, newSessionId, isSessionStore } from "../src/store";
import { memoryStore } from "@lite-agent/core";
import type { Message } from "@lite-agent/core";

const freshDir = () => mkdtempSync(join(tmpdir(), "lite-store-"));

test("jsonlStore returns null for an unknown session", async () => {
  const store = jsonlStore({ dir: freshDir() });
  expect(await store.load("nope")).toBeNull();
});

test("jsonlStore round-trips a transcript through disk", async () => {
  const dir = freshDir();
  const msgs: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "yo" }] },
  ];
  await jsonlStore({ dir }).save("s1", msgs);
  // a *separate* instance reads it back — proves it survives process boundaries
  expect(await jsonlStore({ dir }).load("s1")).toEqual(msgs);
});

test("jsonlStore writes one session per file under the dir", async () => {
  const dir = freshDir();
  const store = jsonlStore({ dir });
  await store.save("alpha", [{ role: "user", content: "a" }]);
  expect(existsSync(join(dir, "alpha.jsonl"))).toBe(true);
});

test("jsonlStore keeps a path-traversal session id inside the dir", async () => {
  const dir = freshDir();
  const store = jsonlStore({ dir });
  await store.save("../escape", [{ role: "user", content: "x" }]);
  expect(existsSync(join(dir, "..", "escape.jsonl"))).toBe(false);
  expect(await store.load("../escape")).toEqual([{ role: "user", content: "x" }]);
});

test("list() returns ids with mtime, most-recent first", async () => {
  const dir = freshDir();
  const store = jsonlStore({ dir });
  await store.save("older", [{ role: "user", content: "a" }]);
  await store.save("newer", [{ role: "user", content: "b" }]);
  // Force deterministic mtimes so ordering is not a race.
  utimesSync(join(dir, "older.jsonl"), new Date(1000), new Date(1000));
  utimesSync(join(dir, "newer.jsonl"), new Date(2000), new Date(2000));
  const list = await store.list();
  expect(list.map((s) => s.id)).toEqual(["newer", "older"]);
  expect(list[0]!.mtime).toBeGreaterThan(list[1]!.mtime);
});

test("list() returns [] for a missing directory", async () => {
  const store = jsonlStore({ dir: join(tmpdir(), "lite-store-missing-xyz123") });
  expect(await store.list()).toEqual([]);
});

test("delete() removes a session file and is idempotent", async () => {
  const dir = freshDir();
  const store = jsonlStore({ dir });
  await store.save("gone", [{ role: "user", content: "x" }]);
  expect(existsSync(join(dir, "gone.jsonl"))).toBe(true);
  await store.delete("gone");
  expect(existsSync(join(dir, "gone.jsonl"))).toBe(false);
  await store.delete("gone"); // missing file → no throw
});

test("newSessionId() is unique and sortable-formatted", () => {
  const a = newSessionId();
  const b = newSessionId();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^s-[0-9a-z]+-[0-9a-f]{6}$/);
});

test("isSessionStore distinguishes jsonlStore from a plain Store", () => {
  expect(isSessionStore(jsonlStore({ dir: freshDir() }))).toBe(true);
  expect(isSessionStore(memoryStore())).toBe(false);
  expect(isSessionStore(undefined)).toBe(false);
});
