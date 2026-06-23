import { expect, test } from "vitest";
import { memoryStore } from "../src/store";
import type { Message } from "../src/types";

test("memoryStore returns null for an unknown session", async () => {
  const store = memoryStore();
  expect(await store.load("missing")).toBeNull();
});

test("memoryStore round-trips messages by session id", async () => {
  const store = memoryStore();
  const msgs: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "yo" }] },
  ];
  await store.save("s1", msgs);
  expect(await store.load("s1")).toEqual(msgs);
});

test("memoryStore isolates sessions from each other", async () => {
  const store = memoryStore();
  await store.save("s1", [{ role: "user", content: "a" }]);
  expect(await store.load("s2")).toBeNull();
});

test("memoryStore snapshots on save so later mutation does not leak in", async () => {
  const store = memoryStore();
  const msgs: Message[] = [{ role: "user", content: "a" }];
  await store.save("s1", msgs);
  msgs.push({ role: "user", content: "b" });
  expect(await store.load("s1")).toEqual([{ role: "user", content: "a" }]);
});
