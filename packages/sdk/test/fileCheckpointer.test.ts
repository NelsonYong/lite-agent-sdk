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
