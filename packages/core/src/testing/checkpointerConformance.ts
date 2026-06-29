import assert from "node:assert/strict";
import type { Checkpointer } from "../checkpoint";

const userEvt = (t: string) => ({ type: "user" as const, message: { role: "user" as const, content: t } });
const drain = async (cp: Checkpointer, id: string, opts?: { sinceSeq?: number }) => {
  const out = [] as number[];
  for await (const e of cp.read(id, opts)) out.push(e.seq);
  return out;
};

/** Behavior every Checkpointer backend must satisfy. Each case throws on failure. */
export const checkpointerConformance: Array<{ name: string; run: (make: () => Checkpointer) => Promise<void> }> = [
  {
    name: "append returns monotonic head and read replays in seq order",
    run: async (make) => {
      const cp = make();
      assert.equal(await cp.head("s"), 0);
      assert.equal(await cp.append("s", [userEvt("a"), userEvt("b")]), 2);
      assert.equal(await cp.append("s", [userEvt("c")]), 3);
      assert.deepEqual(await drain(cp, "s"), [1, 2, 3]);
      assert.equal(await cp.head("s"), 3);
    },
  },
  {
    name: "read sinceSeq yields only later events",
    run: async (make) => {
      const cp = make();
      await cp.append("s", [userEvt("a"), userEvt("b"), userEvt("c")]);
      assert.deepEqual(await drain(cp, "s", { sinceSeq: 1 }), [2, 3]);
    },
  },
  {
    name: "stale expectedHead rejects; correct one succeeds",
    run: async (make) => {
      const cp = make();
      await cp.append("s", [userEvt("a")]);
      await assert.rejects(() => cp.append("s", [userEvt("b")], 0));
      assert.equal(await cp.append("s", [userEvt("b")], 1), 2);
    },
  },
  {
    name: "list reports sessions and delete removes a log",
    run: async (make) => {
      const cp = make();
      await cp.append("s1", [userEvt("a")]);
      await cp.append("s2", [userEvt("b")]);
      assert.deepEqual((await cp.list()).map((i) => i.id).sort(), ["s1", "s2"]);
      await cp.delete("s1");
      assert.deepEqual((await cp.list()).map((i) => i.id), ["s2"]);
      assert.equal(await cp.head("s1"), 0);
    },
  },
  {
    name: "concurrent appends to one session serialize to a contiguous seq range",
    run: async (make) => {
      const cp = make();
      await Promise.all(Array.from({ length: 10 }, (_, i) => cp.append("s", [userEvt(`e${i}`)])));
      assert.deepEqual(await drain(cp, "s"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    },
  },
  {
    name: "event payloads round-trip through read",
    run: async (make) => {
      const cp = make();
      await cp.append("s", [userEvt("hello")]);
      const out = [];
      for await (const e of cp.read("s")) out.push(e.event);
      assert.deepEqual(out, [userEvt("hello")]);
    },
  },
];
