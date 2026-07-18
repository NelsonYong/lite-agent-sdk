import { createHash } from "node:crypto";
import type { SessionEvent, StoredEvent } from "./checkpoint";
import type { Message, ToolResultBlock, ToolSpec } from "./types";

export type Fact =
  | {
      readonly id: string;
      readonly kind: "goal" | "constraint";
      readonly text: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "artifact";
      readonly text: string;
      readonly path: string;
      readonly revision?: string;
      readonly verification: {
        readonly command: string;
        readonly result: string;
      };
      readonly evidenceRefs: readonly string[];
    };

export type StateEntry = {
  readonly key: string;
  readonly value: string;
  readonly evidenceRefs: readonly string[];
};

/** A rendered conversation segment. Message ranges use an exclusive end. */
export type ContextSegment = {
  readonly id: string;
  readonly eventRange: readonly [fromSeq: number, toSeq: number] | null;
  readonly sourceSeqs: readonly number[];
  readonly messageRange: readonly [start: number, end: number];
  readonly messages: readonly Message[];
};

export type ContextView = {
  readonly generation: number;
  readonly facts: readonly Fact[];
  readonly workingState: readonly StateEntry[];
  readonly segments: readonly ContextSegment[];
  readonly archiveRefs: readonly string[];
  readonly messages: readonly Message[];
  readonly prefixFingerprint: string;
};

export type StaticPrefixInput = {
  readonly system?: string;
  readonly tools?: readonly ToolSpec[];
  readonly codec?: unknown;
};

export type ProjectContextOptions = {
  readonly staticPrefix?: StaticPrefixInput;
  /** Keep whole recent segments up to this soft message limit. */
  readonly maxMessages?: number;
};

type MutableSegment = {
  id: string;
  eventRange: [number, number] | null;
  sourceSeqs: number[];
  messages: Message[];
};

type StoredContextView = Omit<StoredEvent, "event"> & {
  event: Extract<SessionEvent, { type: "context_view" }>;
};

const GOAL = /\b(?:goal|objective)\b|(?:目标|目的)/iu;
const CONSTRAINT = /\b(?:constraint|requirement|must|must not|acceptance criteria)\b|(?:约束|要求|必须|不得|不要|不能|不应该|验收)/iu;

/** Derive a model view without mutating the event log or a committed view. */
export function projectContext(
  events: readonly StoredEvent[],
  options: ProjectContextOptions = {},
): ContextView {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const committed = latestCommittedView(ordered);
  const facts = collectFacts(ordered);
  let segments = committed ? copySegments(committed, committed.seq) : [];
  const afterSeq = committed?.event.throughSeq ?? 0;

  segments = appendRawEvents(
    segments,
    ordered.filter(({ seq }) => seq > afterSeq),
  );
  segments = selectTail(segments, options.maxMessages);
  const finalized = finalizeSegments(segments);

  return {
    generation: committed?.event.view.generation ?? 0,
    facts,
    workingState: [...(committed?.event.view.workingState ?? [])],
    segments: finalized,
    archiveRefs: [...(committed?.event.view.archiveRefs ?? [])],
    messages: finalized.flatMap(({ messages }) => messages),
    prefixFingerprint: fingerprint(options.staticPrefix),
  };
}

function latestCommittedView(events: readonly StoredEvent[]) {
  let latest: StoredContextView | undefined;
  for (const entry of events) {
    if (entry.event.type !== "context_view") continue;
    if (entry.event.throughSeq < 0 || entry.event.throughSeq >= entry.seq) continue;
    if (!Array.isArray(entry.event.view.messages)) continue;
    latest = entry as StoredContextView;
  }
  return latest;
}

function copySegments(entry: StoredContextView, seq: number): MutableSegment[] {
  const { view } = entry.event;
  const segmentMessageCount = view.segments.reduce((sum, segment) => sum + segment.messages.length, 0);
  if (view.segments.length > 0 && segmentMessageCount === view.messages.length) {
    return view.segments.map((segment) => ({
      id: segment.id,
      eventRange: segment.eventRange ? [...segment.eventRange] : null,
      sourceSeqs: [...segment.sourceSeqs],
      messages: [...segment.messages],
    }));
  }
  if (view.messages.length === 0) return [];
  return [{
    id: `derived:${view.generation}:${seq}`,
    eventRange: null,
    sourceSeqs: [],
    messages: [...view.messages],
  }];
}

function appendRawEvents(initial: MutableSegment[], events: readonly StoredEvent[]): MutableSegment[] {
  let segments = initial.map(copyMutableSegment);
  let active = segments.at(-1);
  let pending: ToolResultBlock[] = [];

  const ensureActive = () => {
    if (!active) {
      active = { id: "", eventRange: null, sourceSeqs: [], messages: [] };
      segments.push(active);
    }
    return active;
  };
  const addSeq = (segment: MutableSegment, seq: number) => {
    if (segment.sourceSeqs.at(-1) !== seq) segment.sourceSeqs.push(seq);
    segment.eventRange = segment.eventRange
      ? [Math.min(segment.eventRange[0], seq), Math.max(segment.eventRange[1], seq)]
      : [seq, seq];
  };
  const flushResults = () => {
    if (pending.length === 0) return;
    ensureActive().messages.push({ role: "user", content: pending });
    pending = [];
  };
  const startSegment = (seq: number, message: Message) => {
    flushResults();
    active = { id: "", eventRange: [seq, seq], sourceSeqs: [seq], messages: [message] };
    segments.push(active);
  };

  for (const entry of events) {
    const { event, seq } = entry;
    switch (event.type) {
      case "user":
        startSegment(seq, event.message);
        break;
      case "assistant": {
        flushResults();
        const segment = ensureActive();
        segment.messages.push(event.message);
        addSeq(segment, seq);
        break;
      }
      case "tool_result": {
        const segment = ensureActive();
        pending.push(event.result);
        addSeq(segment, seq);
        break;
      }
      case "summary":
        pending = [];
        segments = event.messages.length === 0 ? [] : [{
          id: `summary:${seq}`,
          eventRange: [seq, seq],
          sourceSeqs: [seq],
          messages: [...event.messages],
        }];
        active = segments.at(-1);
        break;
      case "context_view":
        break;
      default:
        if (active) addSeq(active, seq);
    }
  }
  flushResults();
  return segments.filter(({ messages }) => messages.length > 0);
}

function collectFacts(events: readonly StoredEvent[]): Fact[] {
  const facts: Fact[] = [];
  let sawUser = false;
  for (const entry of events) {
    const evidenceRefs = [`${entry.sessionId}:${entry.seq}`];
    if (entry.event.type === "user") {
      const text = messageText(entry.event.message).trim();
      if (!text) continue;
      const kind = CONSTRAINT.test(text) ? "constraint" : GOAL.test(text) || !sawUser ? "goal" : undefined;
      sawUser = true;
      if (!kind) continue;
      facts.push({
        id: `${entry.sessionId}:${entry.seq}:${kind}`,
        kind,
        text,
        evidenceRefs,
      });
      continue;
    }
    if (entry.event.type === "artifact_verified") {
      facts.push({
        id: `${entry.sessionId}:${entry.seq}:artifact`,
        kind: "artifact",
        text: entry.event.path,
        path: entry.event.path,
        ...(entry.event.revision === undefined ? {} : { revision: entry.event.revision }),
        verification: { command: entry.event.command, result: entry.event.result },
        evidenceRefs,
      });
    }
  }
  return facts;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function selectTail(segments: MutableSegment[], maxMessages?: number): MutableSegment[] {
  if (maxMessages === undefined || !Number.isFinite(maxMessages) || maxMessages < 1) return segments;
  const budget = Math.floor(maxMessages);
  const selected: MutableSegment[] = [];
  let count = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    if (selected.length > 0 && count + segment.messages.length > budget) break;
    selected.unshift(segment);
    count += segment.messages.length;
  }
  return selected;
}

function finalizeSegments(segments: readonly MutableSegment[]): ContextSegment[] {
  let cursor = 0;
  return segments.map((segment) => {
    const start = cursor;
    cursor += segment.messages.length;
    const eventRange = segment.sourceSeqs.length > 0
      ? [segment.sourceSeqs[0]!, segment.sourceSeqs.at(-1)!] as const
      : segment.eventRange;
    return {
      id: eventRange ? `${eventRange[0]}-${eventRange[1]}` : segment.id,
      eventRange,
      sourceSeqs: [...segment.sourceSeqs],
      messageRange: [start, cursor],
      messages: [...segment.messages],
    };
  });
}

function copyMutableSegment(segment: MutableSegment): MutableSegment {
  return {
    id: segment.id,
    eventRange: segment.eventRange ? [...segment.eventRange] : null,
    sourceSeqs: [...segment.sourceSeqs],
    messages: [...segment.messages],
  };
}

function fingerprint(input: StaticPrefixInput = {}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return current;
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
    );
  }) ?? "null";
}
