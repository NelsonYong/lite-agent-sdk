import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memorySpillStore } from "@lite-agent/core";
import { fileSpillStore, readSpilledTool } from "../src/spill";

const dir = () => mkdtempSync(join(tmpdir(), "spill-"));

test("fileSpillStore round-trips content through disk across instances", () => {
  const d = dir();
  const ref = fileSpillStore({ dir: d }).put("big content");
  expect(fileSpillStore({ dir: d }).get(ref)).toBe("big content");
});

test("fileSpillStore returns null for an unknown ref", () => {
  expect(fileSpillStore({ dir: dir() }).get("deadbeef")).toBeNull();
});

test("fileSpillStore dedups identical content to the same ref", () => {
  const s = fileSpillStore({ dir: dir() });
  expect(s.put("same")).toBe(s.put("same"));
});

test("readSpilledTool returns the spilled content by ref", async () => {
  const store = memorySpillStore();
  const ref = store.put("recovered text");
  const out = await readSpilledTool(store).execute({ ref }, {} as any);
  expect(out).toBe("recovered text");
});

test("readSpilledTool reports a missing ref instead of throwing", async () => {
  const out = await readSpilledTool(memorySpillStore()).execute({ ref: "nope" }, {} as any);
  expect(out).toMatch(/No spilled content/);
});
