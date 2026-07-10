import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync,
} from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { dirname } from "node:path";
import { defaultRedactor } from "@lite-agent/core";
import type { AgentEvent, Redactor } from "@lite-agent/core";

export interface EventRecord {
  v: 1;
  ts: string;
  sessionId: string;
  seq: number;
  prevHash: string | null;
  hash: string;
  event: AgentEvent;
}

export interface EventSink {
  write(sessionId: string, event: AgentEvent): Promise<void>;
  close(): Promise<void>;
}

export interface JsonlEventSinkOptions {
  file: string;
  maxBytes?: number;
  maxFiles?: number;
  redactor?: Redactor;
  integrityKey?: string | Buffer;
  durable?: boolean;
}

function lastRecord(file: string): EventRecord | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split("\n").filter(Boolean).at(-1);
  if (!line) return undefined;
  return JSON.parse(line) as EventRecord;
}

export function jsonlEventSink(opts: JsonlEventSinkOptions): EventSink {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxFiles = Math.max(1, opts.maxFiles ?? 5);
  const redact = opts.redactor ?? defaultRedactor;
  const prior = lastRecord(opts.file);
  let seq = prior?.seq ?? 0;
  let previous = prior?.hash ?? null;
  let chain: Promise<void> = Promise.resolve();

  const rotate = (incomingBytes: number) => {
    if (!existsSync(opts.file) || statSync(opts.file).size + incomingBytes <= maxBytes) return;
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? opts.file : `${opts.file}.${i - 1}`;
      const to = `${opts.file}.${i}`;
      if (existsSync(from)) renameSync(from, to);
    }
  };
  const digest = (payload: string) => opts.integrityKey
    ? createHmac("sha256", opts.integrityKey).update(payload).digest("hex")
    : createHash("sha256").update(payload).digest("hex");

  return {
    write(sessionId, event) {
      const run = chain.then(() => {
        const ts = new Date().toISOString();
        const nextSeq = seq + 1;
        const safeEvent = redact(event) as AgentEvent;
        const unsigned = { v: 1 as const, ts, sessionId, seq: nextSeq, prevHash: previous, event: safeEvent };
        const hash = digest(`${previous ?? ""}\n${JSON.stringify(unsigned)}`);
        const record: EventRecord = { ...unsigned, hash };
        const line = `${JSON.stringify(record)}\n`;
        mkdirSync(dirname(opts.file), { recursive: true });
        rotate(Buffer.byteLength(line));
        if (opts.durable !== false) {
          const fd = openSync(opts.file, "a");
          try { appendFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
        } else {
          appendFileSync(opts.file, line);
        }
        seq = nextSeq;
        previous = hash;
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    async close() { await chain; },
  };
}

export async function* recordEventStream<R>(
  stream: AsyncGenerator<AgentEvent, R>,
  sink: EventSink,
  sessionId: string,
): AsyncGenerator<AgentEvent, R> {
  let next = await stream.next();
  while (!next.done) {
    await sink.write(sessionId, next.value);
    yield next.value;
    next = await stream.next();
  }
  return next.value;
}
