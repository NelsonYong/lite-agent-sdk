import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { Checkpointer, StoredEvent } from "@lite-agent/core";
import { AgentError, CheckpointConflictError } from "@lite-agent/core";
import { atomicWriteFile, resolveSafePath } from "./tools/file";

export interface CheckpointInfo {
  seq: number;
  prompt: string;
  ts: string;
  files: string[];
  unavailableFiles: string[];
}

export interface RestoreResult {
  restoredFiles: string[];
  conversationRestored: boolean;
}

export async function checkpointEntries(cp: Checkpointer, id: string): Promise<StoredEvent[]> {
  const entries: StoredEvent[] = [];
  for await (const entry of cp.read(id)) entries.push(entry);
  return entries;
}

export function checkpointList(entries: StoredEvent[]): CheckpointInfo[] {
  const snapshots = new Map<string, boolean>();
  const checkpoints: CheckpointInfo[] = [];
  for (const entry of [...entries].reverse()) {
    const event = entry.event;
    if (event.type === "file_snapshot") snapshots.set(event.path, event.truncated === true);
    if (event.type !== "user" || event.message.role !== "user") continue;
    const prompt = typeof event.message.content === "string" ? event.message.content
      : event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    // Old logs did not record provenance. Exclude known runtime envelopes when
    // deriving legacy anchors; new logs use the explicit marker exclusively.
    const legacy = event.checkpoint === undefined && event.origin === undefined &&
      !/^\s*<(?:background-task-completed|system-reminder)\b/u.test(prompt);
    if ((!event.checkpoint && !legacy) || !prompt.trim()) continue;
    checkpoints.push({ seq: entry.seq - 1, prompt, ts: entry.ts,
      files: [...snapshots.keys()], unavailableFiles: [...snapshots].filter(([, missing]) => missing).map(([path]) => path) });
  }
  return checkpoints.reverse();
}

const hash = (body: Buffer | null) => body === null ? null : createHash("sha256").update(body).digest("hex");

/** Preflight every file before changing any; restore local changes on failure. */
export async function restoreCheckpoint(
  cp: Checkpointer, workdir: string, id: string, toSeq: number,
  opts: { files?: boolean; conversation?: boolean },
  progress: (completed: number, total: number) => void,
  signal: AbortSignal,
): Promise<RestoreResult> {
  signal.throwIfAborted();
  const entries = await checkpointEntries(cp, id);
  const head = await cp.head(id);
  if (!entries.length && !(await cp.list()).some((entry) => entry.id === id)) throw new AgentError(`Unknown session '${id}'`);
  if (!Number.isSafeInteger(toSeq) || toSeq < 0 || toSeq > head || (toSeq !== 0 && !entries.some((e) => e.seq === toSeq)))
    throw new AgentError("Checkpoint sequence must identify an existing event or zero");
  const conversation = opts.conversation ?? true;
  if (conversation && !cp.truncate) throw new AgentError("conversation restore requires a checkpointer that supports truncate");
  if (conversation) {
    const pending = new Set<string>();
    for (const { event } of entries.filter((entry) => entry.seq <= toSeq)) {
      if (event.type === "assistant") for (const block of event.message.content) {
        if (block.type === "tool_call") pending.add(block.id);
      }
      if (event.type === "tool_result") pending.delete(event.result.id);
    }
    if (pending.size) throw new AgentError("Checkpoint splits unfinished tool calls; choose a listed checkpoint");
  }
  const selected = entries.filter((entry) => entry.seq > toSeq);
  const plans = new Map<string, { path: string; before: Buffer | null; backup: Buffer | null; expected?: string | null; previous?: string | null }>();
  if (opts.files !== false) {
    for (const { event } of selected) {
      if (event.type !== "file_snapshot") continue;
      const file = resolveSafePath(workdir, event.path, { mode: "write", symlinks: "deny" });
      let plan = plans.get(file);
      if (!plan) {
        if (event.truncated) throw new AgentError(`Cannot restore '${event.path}': its snapshot was truncated; use conversation-only restore`);
        const before = event.before === null ? null : Buffer.from(event.before, event.encoding ?? "utf8");
        plan = { path: event.path, before, backup: existsSync(file) ? readFileSync(file) : null };
        plans.set(file, plan);
      }
      plan.expected = event.after;
      plan.previous = event.before === null ? null : hash(Buffer.from(event.before, event.encoding ?? "utf8"));
    }
    for (const plan of plans.values()) {
      const current = hash(plan.backup);
      if (plan.expected !== undefined && current !== plan.expected && current !== plan.previous)
        throw new AgentError(`File '${plan.path}' changed outside the recorded operation; refusing to overwrite it`);
    }
  }
  const actual = await cp.head(id);
  if (actual !== head) throw new CheckpointConflictError(id, head, actual);
  const applied: string[] = [];
  const write = (file: string, body: Buffer | null) => {
    if (body === null) { if (existsSync(file)) unlinkSync(file); }
    else atomicWriteFile(file, body);
  };
  progress(0, plans.size);
  try {
    for (const [file, plan] of plans) {
      signal.throwIfAborted();
      resolveSafePath(workdir, plan.path, { mode: "write", symlinks: "deny" });
      const current = existsSync(file) ? readFileSync(file) : null;
      if (hash(current) !== hash(plan.backup)) throw new AgentError(`File '${plan.path}' changed during restore`);
      write(file, plan.before);
      applied.push(file);
      progress(applied.length, plans.size);
    }
    signal.throwIfAborted();
    if (conversation) await cp.truncate!(id, toSeq, head);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const file of applied.reverse()) {
      try { write(file, plans.get(file)!.backup); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Restore failed and some files could not be rolled back");
    throw error;
  }
  return { restoredFiles: [...plans.values()].map((plan) => plan.path), conversationRestored: conversation };
}
