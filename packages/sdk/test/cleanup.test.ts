import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStale } from "../src/cleanup";

const DAY = 86_400_000;

// Build <home>/projects/<proj>/<sub>/<file>, optionally aged `ageDays` old.
function seed(home: string, proj: string, sub: string, file: string, ageDays: number): string {
  const dir = join(home, "projects", proj, sub);
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, file);
  writeFileSync(fp, "x");
  const when = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(fp, when, when);
  return fp;
}

test("deletes files older than maxAgeDays, keeps fresh ones, across projects", () => {
  const home = mkdtempSync(join(tmpdir(), "sweep-"));
  const oldA = seed(home, "projA", "spill", "old.txt", 40);
  const freshA = seed(home, "projA", "sessions", "fresh.jsonl", 1);
  const oldB = seed(home, "projB", "sessions", "old.jsonl", 31);

  sweepStale({ home, maxAgeDays: 30 });

  expect(existsSync(oldA)).toBe(false);
  expect(existsSync(oldB)).toBe(false);
  expect(existsSync(freshA)).toBe(true);
});

test("tolerates a missing home without throwing", () => {
  expect(() => sweepStale({ home: join(tmpdir(), "no-such-home-xyz") })).not.toThrow();
});
