import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointerConformance } from "@lite-agent/core";
import { fileCheckpointer } from "../src/checkpoint";

for (const c of checkpointerConformance) {
  test(`fileCheckpointer: ${c.name}`, async () => {
    await c.run(() => fileCheckpointer({ dir: mkdtempSync(join(tmpdir(), "fc-")) }));
  });
}

test("fileCheckpointer survives a fresh instance over the same dir (durable)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-"));
  const a = fileCheckpointer({ dir });
  await a.append("s", [{ type: "user", message: { role: "user", content: "hi" } }]);
  const b = fileCheckpointer({ dir }); // new process/instance
  expect(await b.head("s")).toBe(1);
  const seen: number[] = [];
  for await (const e of b.read("s")) seen.push(e.seq);
  expect(seen).toEqual([1]);
});

test("fileCheckpointer.truncate rewrites the log up to toSeq", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-"));
  const cp = fileCheckpointer({ dir });
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
  // a fresh instance (cold head cache) must agree
  expect(await fileCheckpointer({ dir }).head("s")).toBe(2);
});
