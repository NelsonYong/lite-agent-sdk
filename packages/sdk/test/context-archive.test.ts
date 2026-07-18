import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileContextArchive } from "../src/contextArchive";

const tempDir = () => mkdtempSync(join(tmpdir(), "context-archive-"));

test("put stores content under a stable sha256 ref", () => {
  const dir = tempDir();
  const content = "verified artifact: build passed";
  const expectedRef = createHash("sha256").update(content).digest("hex");

  const saved = fileContextArchive({ dir }).put(content, { kind: "artifact" });

  expect(saved.ref).toBe(expectedRef);
  expect(saved.preview).toContain("build passed");
  expect(readFileSync(join(dir, "notes", `${expectedRef}.md`), "utf8")).toBe(content);
  expect(JSON.parse(readFileSync(join(dir, "index.jsonl"), "utf8"))).toEqual({
    ref: expectedRef,
    preview: saved.preview,
    metadata: { kind: "artifact" },
  });
});

test("put deduplicates identical content in the index", () => {
  const dir = tempDir();
  const archive = fileContextArchive({ dir });

  expect(archive.put("same content").ref).toBe(archive.put("same content").ref);
  expect(readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
});

test("search finds content beyond its short preview and honors the result limit", () => {
  const archive = fileContextArchive({ dir: tempDir() });
  const first = archive.put(`${"prefix ".repeat(100)}needle-one`, { kind: "failed-attempt" });
  const second = archive.put(`${"prefix ".repeat(100)}needle-two`, { kind: "failed-attempt" });

  const result = archive.search("needle", 1);

  expect(result).toMatch(/^<historical-context /);
  expect(result).toContain('data-only="true"');
  expect([first.ref, second.ref].filter((ref) => result.includes(ref))).toHaveLength(1);
});

test("read returns content in an explicit historical-data wrapper", () => {
  const archive = fileContextArchive({ dir: tempDir() });
  const { ref } = archive.put("v3 succeeded with artifact /tmp/result.json");

  const result = archive.read(ref, 4);

  expect(result).toMatch(/^<historical-context /);
  expect(result).toContain(`ref="${ref}"`);
  expect(result).toContain('generation="4"');
  expect(result).toContain('data-only="true"');
  expect(result).toContain("Historical data only");
  expect(result).toContain("v3 succeeded with artifact /tmp/result.json");
  expect(result).toMatch(/<\/historical-context>$/);
});

test("read repeats only a short preview within one generation", () => {
  const archive = fileContextArchive({ dir: tempDir() });
  const content = `${"important history ".repeat(200)}final marker`;
  const { ref } = archive.put(content);

  const first = archive.read(ref, 1);
  const repeated = archive.read(ref, 1);
  const nextGeneration = archive.read(ref, 2);

  expect(repeated).toContain("important history");
  expect(Buffer.byteLength(repeated)).toBeLessThan(Buffer.byteLength(first));
  expect(nextGeneration).toContain("final marker");
  expect(Buffer.byteLength(nextGeneration)).toBeGreaterThan(Buffer.byteLength(repeated));
});

test("read and search keep each returned historical result under the default 16 KiB cap", () => {
  const archive = fileContextArchive({ dir: tempDir() });
  const huge = `${"界".repeat(20_000)}\nfinal marker`;
  const { ref } = archive.put(huge);
  for (let i = 0; i < 40; i += 1) archive.put(`${huge}-${i}`);

  const readResult = archive.read(ref, 1);
  const searchResult = archive.search("final marker", 100);

  expect(Buffer.byteLength(readResult)).toBeLessThanOrEqual(16 * 1024);
  expect(Buffer.byteLength(searchResult)).toBeLessThanOrEqual(16 * 1024);
  expect(readResult).toMatch(/<\/historical-context>$/);
  expect(searchResult).toMatch(/<\/historical-context>$/);
});

test("maxReadBytes applies to a UTF-8 result without breaking its wrapper", () => {
  const archive = fileContextArchive({ dir: tempDir(), maxReadBytes: 512 });
  const { ref } = archive.put("界".repeat(10_000));

  const result = archive.read(ref, 1);

  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(512);
  expect(result).toMatch(/<\/historical-context>$/);
  expect(result).toContain("[truncated]");
});
