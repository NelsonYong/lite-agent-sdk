import { expect, test } from "vitest";
import { legacyStoreAdapter, foldEvents } from "../src/checkpoint";
import { memoryStore } from "../src/store";

const userEvt = (t: string) => ({ type: "user" as const, message: { role: "user" as const, content: t } });

test("appends fold to the wrapped Store and read replays the folded state", async () => {
  const store = memoryStore();
  const cp = legacyStoreAdapter(store);
  await cp.append("s", [userEvt("a")]);
  await cp.append("s", [userEvt("b")]);
  // the wrapped store holds the folded messages
  expect(await store.load("s")).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
  // read replays them as synthetic events that fold back to the same messages
  const events = [];
  for await (const e of cp.read("s")) events.push(e.event);
  expect(foldEvents(events)).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
  expect(await cp.head("s")).toBe(2);
});
