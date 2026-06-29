import { expect, test } from "vitest";
import { memoryCheckpointer } from "../src/checkpoint";
import { CheckpointConflictError } from "../src/events";

const userEvt = (t: string) => ({ type: "user" as const, message: { role: "user" as const, content: t } });

test("append returns a monotonic head; read replays in seq order", async () => {
  const cp = memoryCheckpointer();
  expect(await cp.head("s")).toBe(0);
  const h1 = await cp.append("s", [userEvt("a"), userEvt("b")]);
  expect(h1).toBe(2);
  const h2 = await cp.append("s", [userEvt("c")]);
  expect(h2).toBe(3);
  const seen: number[] = [];
  for await (const e of cp.read("s")) seen.push(e.seq);
  expect(seen).toEqual([1, 2, 3]);
  expect(await cp.head("s")).toBe(3);
});

test("read({sinceSeq}) yields only later events", async () => {
  const cp = memoryCheckpointer();
  await cp.append("s", [userEvt("a"), userEvt("b"), userEvt("c")]);
  const seen: number[] = [];
  for await (const e of cp.read("s", { sinceSeq: 1 })) seen.push(e.seq);
  expect(seen).toEqual([2, 3]);
});

test("append with a stale expectedHead throws CheckpointConflictError", async () => {
  const cp = memoryCheckpointer();
  await cp.append("s", [userEvt("a")]); // head now 1
  await expect(cp.append("s", [userEvt("b")], 0)).rejects.toBeInstanceOf(CheckpointConflictError);
  // a correct expectedHead succeeds
  expect(await cp.append("s", [userEvt("b")], 1)).toBe(2);
});

test("list returns appended sessions; delete removes a log", async () => {
  const cp = memoryCheckpointer();
  await cp.append("s1", [userEvt("a")]);
  await cp.append("s2", [userEvt("b")]);
  expect((await cp.list()).map((i) => i.id).sort()).toEqual(["s1", "s2"]);
  await cp.delete("s1");
  expect((await cp.list()).map((i) => i.id)).toEqual(["s2"]);
  expect(await cp.head("s1")).toBe(0);
});
