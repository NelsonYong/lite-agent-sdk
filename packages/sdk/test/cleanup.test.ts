import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStale } from "../src/cleanup";

const DAY = 86_400_000;

// A single event-format line, so a sessions `.jsonl` is not treated as a legacy
// whole-array transcript (which the sweep discards regardless of age).
const EVENT_LINE = JSON.stringify({
  seq: 1,
  sessionId: "s",
  parentSeq: null,
  ts: "2020-01-01T00:00:00.000Z",
  event: { type: "user", message: { role: "user", content: "hi" } },
});

// Build <home>/projects/<proj>/<sub>/<file>, optionally aged `ageDays` old.
function seed(home: string, proj: string, sub: string, file: string, ageDays: number, content = "x"): string {
  const dir = join(home, "projects", proj, sub);
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, file);
  writeFileSync(fp, content);
  const when = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(fp, when, when);
  return fp;
}

test("deletes files older than maxAgeDays, keeps fresh ones, across projects", () => {
  const home = mkdtempSync(join(tmpdir(), "sweep-"));
  const oldA = seed(home, "projA", "spill", "old.txt", 40);
  const freshA = seed(home, "projA", "sessions", "fresh.jsonl", 1, EVENT_LINE);
  const oldB = seed(home, "projB", "sessions", "old.jsonl", 31, EVENT_LINE);

  sweepStale({ home, maxAgeDays: 30 });

  expect(existsSync(oldA)).toBe(false);
  expect(existsSync(oldB)).toBe(false);
  expect(existsSync(freshA)).toBe(true);
});

test("discards a legacy whole-array session transcript regardless of age", () => {
  const home = mkdtempSync(join(tmpdir(), "sweep-"));
  // A pre-event-sourcing transcript: first line is a bare Message, not a `{seq:..}` event.
  const legacy = seed(home, "projA", "sessions", "fresh.jsonl", 1, '{"role":"user","content":"hi"}');
  // An event-format session of the same fresh age must survive.
  const kept = seed(home, "projA", "sessions", "events.jsonl", 1, EVENT_LINE);

  sweepStale({ home, maxAgeDays: 30 });

  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(kept)).toBe(true);
});

test("tolerates a missing home without throwing", () => {
  expect(() => sweepStale({ home: join(tmpdir(), "no-such-home-xyz") })).not.toThrow();
});
