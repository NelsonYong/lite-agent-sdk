import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointerConformance } from "@lite-agent/core";
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
