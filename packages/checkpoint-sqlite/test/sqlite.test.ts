import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointerConformance, CheckpointConflictError } from "@lite-agent/core";
import { sqliteCheckpointer } from "../src/index";

const dbFile = () => join(mkdtempSync(join(tmpdir(), "sq-")), "ckpt.db");

for (const c of checkpointerConformance) {
  test(`sqliteCheckpointer: ${c.name}`, async () => {
    await c.run(() => sqliteCheckpointer({ file: dbFile() }));
  });
}

test("durable across reopen of the same file", async () => {
  const file = dbFile();
  const a = sqliteCheckpointer({ file });
  await a.append("s", [{ type: "user", message: { role: "user", content: "hi" } }]);
  a.close();
  const b = sqliteCheckpointer({ file });
  expect(await b.head("s")).toBe(1);
});

test("two clients on one DB file see each other's writes (optimistic concurrency)", async () => {
  // Two independent connections to the same file stand in for two processes. Because
  // every append reads the head from the DB (not a per-instance cache), client B sees
  // A's write, and a stale expectedHead is rejected with CheckpointConflictError.
  const file = dbFile();
  const a = sqliteCheckpointer({ file });
  const b = sqliteCheckpointer({ file });
  const head = await a.append("s", [{ type: "user", message: { role: "user", content: "from A" } }]);
  expect(head).toBe(1);
  // B observes A's append without any cache priming.
  expect(await b.head("s")).toBe(1);
  // B appending against the now-stale head 0 conflicts; against the fresh head 1 it succeeds.
  await expect(b.append("s", [{ type: "user", message: { role: "user", content: "stale" } }], 0)).rejects.toBeInstanceOf(CheckpointConflictError);
  expect(await b.append("s", [{ type: "user", message: { role: "user", content: "from B" } }], 1)).toBe(2);
  // A likewise sees B's committed write.
  expect(await a.head("s")).toBe(2);
  a.close();
  b.close();
});

test("truncate drops events past toSeq and resets head", async () => {
  const cp = sqliteCheckpointer({ file: dbFile() });
  await cp.append("s", [
    { type: "user", message: { role: "user", content: "a" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    { type: "user", message: { role: "user", content: "c" } },
  ]);
  await cp.truncate!("s", 2);
  const seen: number[] = [];
  for await (const e of cp.read("s")) seen.push(e.seq);
  expect(seen).toEqual([1, 2]);
  expect(await cp.head("s")).toBe(2);
  cp.close();
});

test("strict durability options initialize a healthy versioned database", () => {
  const cp = sqliteCheckpointer({
    file: dbFile(), synchronous: "full", busyTimeoutMs: 1000, integrityCheckOnOpen: true,
  });
  expect(cp.checkIntegrity()).toEqual({ ok: true, detail: "ok" });
  cp.close();
});
