import { expect, test } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonlStore } from "../src/store";
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
