import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { jsonlEventSink } from "../src/observability";
import type { EventRecord } from "../src/observability";

test("jsonlEventSink redacts events and maintains a hash chain", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "event-sink-")), "events.jsonl");
  const sink = jsonlEventSink({ file, durable: false });
  await sink.write("s", { type: "text_delta", text: "email me at person@example.com" });
  await sink.write("s", { type: "turn_start", turn: 1 });
  await sink.close();

  const records = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  expect(records[0]!.event).toEqual({ type: "text_delta", text: "email me at [redacted]" });
  expect(records[1]!.prevHash).toBe(records[0]!.hash);
  const { hash: _hash, ...unsigned } = records[1]!;
  expect(records[1]!.hash).toBe(createHash("sha256").update(`${records[0]!.hash}\n${JSON.stringify(unsigned)}`).digest("hex"));
});

test("jsonlEventSink rotates bounded files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "event-rotate-"));
  const file = join(dir, "events.jsonl");
  const sink = jsonlEventSink({ file, maxBytes: 180, maxFiles: 2, durable: false });
  for (let i = 0; i < 8; i++) await sink.write("s", { type: "text_delta", text: `line-${i}-xxxxxxxxxxxxxxxx` });
  await sink.close();
  expect(readdirSync(dir).sort()).toEqual(["events.jsonl", "events.jsonl.1"]);
});

test("jsonlEventSink uses HMAC when an integrity key is provided", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "event-hmac-")), "events.jsonl");
  const sink = jsonlEventSink({ file, integrityKey: "key", durable: false });
  await sink.write("s", { type: "turn_start", turn: 1 });
  await sink.close();
  const record = JSON.parse(readFileSync(file, "utf8")) as EventRecord;
  const { hash: _hash, ...unsigned } = record;
  expect(record.hash).toBe(createHmac("sha256", "key").update(`\n${JSON.stringify(unsigned)}`).digest("hex"));
});
