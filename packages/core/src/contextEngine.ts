import type { Checkpointer, SessionEvent, StoredEvent } from "./checkpoint";
import { memoryCheckpointer, storeEvents } from "./checkpoint";
import { CheckpointConflictError } from "./events";
import {
  projectContext,
  type ContextSegment,
  type ContextView,
  type Fact,
  type StateEntry,
  type StaticPrefixInput,
} from "./context";
import type { ModelProvider } from "./strategies";
import { estimateTokens } from "./compaction/types";
import type { AssistantMessage, ContentBlock, Message, ModelRequest, ToolResultBlock } from "./types";

/** A small, provider-neutral archive seam. SDK archives can implement it synchronously. */
export interface ContextArchive {
  put(
    content: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): ContextArchivePutResult | Promise<ContextArchivePutResult>;
}

export interface ContextArchivePutResult {
  readonly ref: string;
  readonly preview: string;
}

export type ContextProposal = {
  readonly segments?: readonly ContextProposalSegment[];
  readonly stateDelta?: {
    readonly decisions?: readonly string[];
    readonly unresolved?: readonly string[];
    readonly nextStep?: string;
  };
};

export type ContextProposalSegment = {
  readonly id: string;
  readonly action: "keep" | "summarize" | "archive";
  readonly classification?: "failed" | "superseded" | "verified" | "unknown";
  readonly evidenceRefs?: readonly string[];
  readonly summary?: string;
  readonly lesson?: string;
};

export type ContextPlannerInput = {
  readonly sessionId: string;
  readonly reason: string;
  readonly instructions?: string;
  readonly view: ContextView;
  readonly candidates: readonly ContextSegment[];
};

/** Planner is deliberately a delta API: it cannot replace facts or the event log. */
export interface ContextPlanner {
  propose?(input: ContextPlannerInput, signal: AbortSignal): Promise<ContextProposal>;
  plan?(input: ContextPlannerInput, signal: AbortSignal): Promise<ContextProposal>;
}

export type ContextPlannerProvider = {
  readonly provider: ModelProvider;
  readonly model: string;
};

export type ContextLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type ContextStatus = {
  readonly sessionId: string;
  readonly level: ContextLevel;
  readonly reason: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly generation: number;
  readonly plannerUsed: boolean;
  readonly plannerFallback: boolean;
  readonly plannerLatencyMs: number;
  readonly archiveRefs: readonly string[];
  readonly retry: boolean;
};

export interface ContextEngineOptions {
  readonly sessionId: string;
  readonly checkpointer?: Checkpointer;
  readonly provider?: ModelProvider;
  readonly planner?: ContextPlanner | ContextPlannerProvider;
  readonly archive?: ContextArchive;
  readonly windowTokens?: number;
  readonly staticPrefix?: StaticPrefixInput;
}

const DEFAULT_WINDOW = 32_000;
const PLANNER_TIMEOUT_MS = 100;

/**
 * Owns one session's derived context view. The log remains the source of truth;
 * every view written by this class is a derived `context_view` event.
 */
export class ContextEngine {
  readonly sessionId: string;

  private readonly checkpointer: Checkpointer;
  private readonly provider?: ModelProvider;
  private readonly planner?: ContextPlanner | ContextPlannerProvider;
  private readonly archive?: ContextArchive;
  private readonly staticPrefix: StaticPrefixInput;
  private readonly windowTokens: number;
  private loaded = false;
  private head = 0;
  private events: StoredEvent[] = [];
  private viewCache?: ContextView;
  private writes: Promise<void> = Promise.resolve();
  private invalidated = false;
  private readonly snapshotHeads = new Map<number, number>();
  private presentedHead = 0;
  private plannerController?: AbortController;
  private statusValue: ContextStatus;

  constructor(options: ContextEngineOptions) {
    if (!options.sessionId) throw new TypeError("sessionId is required");
    this.sessionId = options.sessionId;
    this.checkpointer = options.checkpointer ?? memoryCheckpointer();
    this.provider = options.provider;
    this.planner = options.planner;
    this.archive = options.archive;
    this.staticPrefix = clone(options.staticPrefix ?? {});
    const configuredWindow = options.windowTokens ?? options.provider?.context?.contextWindow ?? DEFAULT_WINDOW;
    this.windowTokens = Number.isFinite(configuredWindow) && configuredWindow > 0
      ? Math.floor(configuredWindow)
      : DEFAULT_WINDOW;
    this.statusValue = {
      sessionId: this.sessionId,
      level: 0,
      reason: "init",
      beforeTokens: 0,
      afterTokens: 0,
      generation: 0,
      plannerUsed: false,
      plannerFallback: false,
      plannerLatencyMs: 0,
      archiveRefs: [],
      retry: false,
    };
  }

  static create(options: ContextEngineOptions): ContextEngine {
    return new ContextEngine(options);
  }

  /** Last measured pressure, copied so callers cannot mutate engine state. */
  get status(): ContextStatus {
    return freezeDeep(clone(this.statusValue));
  }

  getStatus(): ContextStatus {
    return this.status;
  }

  /**
   * Detect an external writer before any model/provider work. Same-engine writes
   * are serialized below, so routine calls do not race each other.
   */
  async assertHead(): Promise<void> {
    await this.ensureLoaded();
    const actual = await this.checkpointer.head(this.sessionId);
    if (actual !== this.head) {
      throw new CheckpointConflictError(this.sessionId, this.head, actual);
    }
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    const next = [...events];
    const task = this.writes.then(async () => {
      await this.ensureLoaded();
      const from = this.head;
      const newHead = await this.checkpointer.append(this.sessionId, next, from);
      this.events.push(...storeEvents(this.sessionId, from, next));
      this.head = newHead;
      this.viewCache = undefined;
      this.invalidated = false;
    });
    this.writes = task.then(() => undefined, () => undefined);
    await task;
  }

  /**
   * Mark the view seen by a successful model request. We retain the head captured
   * when that generation was rendered; later tool results remain protected.
   */
  async presented(generation: number): Promise<void> {
    await this.assertHead();
    const captured = this.snapshotHeads.get(generation);
    if (captured !== undefined) this.presentedHead = Math.max(this.presentedHead, captured);
  }

  /** Clear in-memory state after restore/delete; the durable log is untouched. */
  invalidate(): void {
    this.plannerController?.abort();
    this.plannerController = undefined;
    this.loaded = false;
    this.invalidated = true;
    this.head = 0;
    this.events = [];
    this.viewCache = undefined;
    this.snapshotHeads.clear();
    this.presentedHead = 0;
  }

  /** Project an immutable view, optionally with a request-local input suffix. */
  async snapshot(input?: readonly Message[]): Promise<ContextView> {
    await this.assertHead();
    const base = this.baseView();
    const view = input && input.length > 0 ? appendInput(base, input) : base;
    this.snapshotHeads.set(view.generation, this.head);
    return freezeDeep(clone(view));
  }

  /**
   * Prepare a model request. Compaction is committed only for durable history;
   * `input` is rendered as a request-local suffix and is never silently persisted.
   */
  async prepare(req: ModelRequest, input?: readonly Message[]): Promise<ContextView> {
    await this.assertHead();
    const base = this.baseView();
    const requestMessages = input && input.length > 0 ? appendInput(base, input).messages : base.messages;
    const before = await this.count(req, requestMessages);
    if (before <= this.windowTokens * 0.65) {
      const view = input && input.length > 0 ? appendInput(base, input) : base;
      this.recordStatus(0, "none", before, before, view, false, false, 0, false);
      this.snapshotHeads.set(view.generation, this.head);
      return freezeDeep(clone(view));
    }

    const result = await this.applyLevels(base, "pressure", undefined, false, before);
    const compactedTokens = await this.count(req, result.view.messages);
    const durable = result.level > 0
      ? await this.commit(result.view, "pressure", before, compactedTokens, result)
      : result.view;
    let rendered = input && input.length > 0 ? appendInput(durable, input) : durable;
    let after = await this.count(req, rendered.messages);
    if (after > this.windowTokens) {
      // Exactly one emergency pass. It is intentionally not a loop: an active
      // input that cannot fit is never truncated or repeatedly re-summarized.
      rendered = input && input.length > 0
        ? appendInput(levelFive(durable), input)
        : levelFive(rendered);
      after = await this.count(req, rendered.messages);
      this.recordStatus(5, "overflow", before, after, rendered, result.plannerUsed, result.plannerFallback, result.plannerLatencyMs, true);
    }
    this.snapshotHeads.set(rendered.generation, this.head);
    return freezeDeep(clone(rendered));
  }

  /** Run the same policy path as automatic pressure, but force a derived view. */
  async compact(reason: string, instructions?: string): Promise<ContextView> {
    await this.assertHead();
    const base = this.baseView();
    const before = await this.measureView(base);
    const result = await this.applyLevels(base, reason || "manual", instructions, true, before);
    if (reason === "overflow") {
      result.view = levelFive(result.view);
      result.level = 5;
    }
    const after = await this.measureView(result.view);
    const committed = await this.commit(result.view, reason || "manual", before, after, result);
    this.snapshotHeads.set(committed.generation, this.head);
    return freezeDeep(clone(committed));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded && !this.invalidated) return;
    const loaded: StoredEvent[] = [];
    for await (const entry of this.checkpointer.read(this.sessionId)) loaded.push(clone(entry));
    this.events = loaded.sort((a, b) => a.seq - b.seq);
    this.head = await this.checkpointer.head(this.sessionId);
    this.loaded = true;
    this.invalidated = false;
  }

  private baseView(): ContextView {
    if (!this.viewCache) {
      this.viewCache = projectContext(this.events, { staticPrefix: this.staticPrefix });
    }
    return clone(this.viewCache);
  }

  private async count(req: ModelRequest, messages: readonly Message[]): Promise<number> {
    const countTokens = this.provider?.context?.countTokens;
    const normalized: ModelRequest = {
      ...req,
      system: this.staticPrefix.system ?? req.system,
      messages: [...clone(messages)],
    };
    if (countTokens) {
      try {
        const value = await countTokens(normalized);
        if (Number.isFinite(value) && value >= 0) return value;
      } catch {
        // Provider token counting is an optimization; deterministic fallback below.
      }
    }
    return estimateRequestTokens(normalized);
  }

  private async measureView(view: ContextView): Promise<number> {
    return this.count({ model: "context", system: this.staticPrefix.system, messages: [...view.messages] }, view.messages);
  }

  private async applyLevels(
    initial: ContextView,
    reason: string,
    instructions: string | undefined,
    force: boolean,
    before: number,
  ): Promise<LevelResult> {
    let view = clone(initial);
    let level: ContextLevel = 0;
    let plannerUsed = false;
    let plannerFallback = false;
    let plannerLatencyMs = 0;

    let pressure = before;
    if (force || pressure > this.windowTokens * 0.65) {
      view = await this.levelOne(view);
      level = 1;
      pressure = await this.measureView(view);
    }
    if (force || pressure > this.windowTokens * 0.75) {
      view = levelTwo(view);
      level = 2;
      pressure = await this.measureView(view);
    }
    if ((force || pressure > this.windowTokens * 0.85) && this.planner) {
      const planned = await this.levelThree(view, reason, instructions);
      view = planned.view;
      plannerUsed = planned.used;
      plannerFallback = planned.fallback;
      plannerLatencyMs = planned.latencyMs;
      level = 3;
      pressure = await this.measureView(view);
    }
    if (force || pressure > this.windowTokens * 0.95) {
      view = levelFour(view);
      level = 4;
      pressure = await this.measureView(view);
    }
    // Level 5 belongs to the pre-stream overflow path in `prepare`; a manual
    // compact never deletes semantic turns merely because its budget is tiny.
    return { view, level, plannerUsed, plannerFallback, plannerLatencyMs };
  }

  private async levelOne(view: ContextView): Promise<ContextView> {
    const consumed = this.consumedToolIds();
    if (consumed.size === 0) return view;
    const externalized = new Set<string>();
    for (const message of view.messages) {
      if (typeof message.content === "string") continue;
      for (const block of message.content) {
        if (block.type === "tool_result" && /^\[tool result (?:archived|externalized)/u.test(block.content)) {
          externalized.add(block.id);
        }
      }
    }
    const byId = new Map<string, { result: ToolResultBlock; seq: number; turn: number }>();
    for (const entry of this.events) {
      if (entry.event.type === "tool_result" && consumed.has(entry.event.result.id)) {
        byId.set(entry.event.result.id, { result: entry.event.result, seq: entry.seq, turn: entry.event.turn });
      }
    }
    const archiveRefs = [...view.archiveRefs];
    const replacements = new Map<string, string>();
    for (const [id, item] of byId) {
      if (externalized.has(id)) continue;
      if (item.result.content.length < 256 || item.result.content.startsWith("[tool result archived:")) continue;
      let marker: string;
      if (this.archive) {
        const saved = await this.archive.put(item.result.content, {
          kind: "tool-result",
          sessionId: this.sessionId,
          seq: item.seq,
          turn: item.turn,
          toolCallId: id,
        });
        if (!archiveRefs.includes(saved.ref)) archiveRefs.push(saved.ref);
        marker = `[tool result archived: ${saved.ref}] ${saved.preview}`;
      } else {
        marker = `[tool result externalized after presentation] ${preview(item.result.content, 160)}`;
      }
      replacements.set(id, marker);
    }
    if (replacements.size === 0) return view;
    return mapViewMessages(view, (message) => mapBlocks(message, (block) => {
      if (block.type !== "tool_result") return block;
      const replacement = replacements.get(block.id);
      return replacement ? { ...block, content: replacement } : block;
    }), archiveRefs);
  }

  private consumedToolIds(): Set<string> {
    const consumed = new Set<string>();
    const awaiting = new Set<string>();
    for (const entry of this.events) {
      if (entry.event.type === "tool_result") {
        awaiting.add(entry.event.result.id);
        if (entry.seq <= this.presentedHead) consumed.add(entry.event.result.id);
      } else if (entry.event.type === "assistant") {
        for (const id of awaiting) consumed.add(id);
        awaiting.clear();
      }
    }
    // Provenance fallback is safe only when an assistant response follows the
    // result; a dangling result has not yet been shown to a model.
    return consumed;
  }

  private async levelThree(view: ContextView, reason: string, instructions?: string): Promise<{
    view: ContextView;
    used: boolean;
    fallback: boolean;
    latencyMs: number;
  }> {
    const started = Date.now();
    const controller = new AbortController();
    this.plannerController = controller;
    const timeout = setTimeout(() => controller.abort(), PLANNER_TIMEOUT_MS);
    try {
      const input: ContextPlannerInput = {
        sessionId: this.sessionId,
        reason,
        ...(instructions ? { instructions } : {}),
        view: freezeDeep(clone(view)),
        candidates: freezeDeep(clone(view.segments)),
      };
      const proposal = await withTimeout(this.callPlanner(input, controller.signal), controller.signal);
      return {
        view: await applyProposal(view, proposal, this.archive, this.sessionId),
        used: true,
        fallback: false,
        latencyMs: Date.now() - started,
      };
    } catch {
      return { view, used: true, fallback: true, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timeout);
      if (this.plannerController === controller) this.plannerController = undefined;
    }
  }

  private async callPlanner(input: ContextPlannerInput, signal: AbortSignal): Promise<ContextProposal> {
    const planner = this.planner!;
    if ("provider" in planner) return plannerProposal(planner.provider, planner.model, input, signal);
    if (typeof planner.propose === "function") return planner.propose(input, signal);
    if (typeof planner.plan === "function") return planner.plan(input, signal);
    return { segments: [], stateDelta: {} };
  }

  private async commit(
    view: ContextView,
    reason: string,
    before: number,
    after: number,
    result: LevelResult,
  ): Promise<ContextView> {
    await this.assertHead();
    const committed = freezeDeep(clone({
      ...view,
      generation: view.generation + 1,
      prefixFingerprint: projectContext([], { staticPrefix: this.staticPrefix }).prefixFingerprint,
    }));
    const throughSeq = this.head;
    await this.append([{ type: "context_view", throughSeq, view: committed }]);
    this.viewCache = committed;
    this.recordStatus(result.level, reason, before, after, committed, result.plannerUsed, result.plannerFallback, result.plannerLatencyMs, false);
    return committed;
  }

  private recordStatus(
    level: ContextLevel,
    reason: string,
    beforeTokens: number,
    afterTokens: number,
    view: ContextView,
    plannerUsed: boolean,
    plannerFallback: boolean,
    plannerLatencyMs: number,
    retry: boolean,
  ): void {
    this.statusValue = freezeDeep({
      sessionId: this.sessionId,
      level,
      reason,
      beforeTokens,
      afterTokens,
      generation: view.generation,
      plannerUsed,
      plannerFallback,
      plannerLatencyMs,
      archiveRefs: [...view.archiveRefs],
      retry,
    });
  }
}

type LevelResult = {
  view: ContextView;
  level: ContextLevel;
  plannerUsed: boolean;
  plannerFallback: boolean;
  plannerLatencyMs: number;
};

export function createContextEngine(options: ContextEngineOptions): ContextEngine {
  return new ContextEngine(options);
}

function appendInput(view: ContextView, input: readonly Message[]): ContextView {
  const messages = [...view.messages, ...clone(input)];
  const segment: ContextSegment = {
    id: `input:${view.generation}:${messages.length}`,
    eventRange: null,
    sourceSeqs: [],
    messageRange: [view.messages.length, messages.length],
    messages: clone(input),
  };
  return {
    ...clone(view),
    segments: [...view.segments, segment],
    messages,
  };
}

function withMessages(view: ContextView, messages: readonly Message[]): ContextView {
  if (messages === view.messages) return clone(view);
  return {
    ...clone(view),
    messages: clone(messages),
    segments: [{
      id: `rendered:${view.generation}`,
      eventRange: null,
      sourceSeqs: [],
      messageRange: [0, messages.length],
      messages: clone(messages),
    }],
  };
}

function mapViewMessages(
  view: ContextView,
  transform: (message: Message) => Message,
  archiveRefs = view.archiveRefs,
): ContextView {
  const segments = view.segments.map((segment) => ({
    ...segment,
    messages: segment.messages.map(transform),
  }));
  return {
    ...clone(view),
    segments: reindexSegments(segments),
    messages: segments.flatMap((segment) => segment.messages),
    archiveRefs: [...archiveRefs],
  };
}

function levelTwo(view: ContextView): ContextView {
  const seenReminders = new Set<string>();
  const result = mapViewMessages(view, (message) => {
    if (message.role !== "user" || typeof message.content !== "string") return message;
    if (!/reminder|background task|task update/iu.test(message.content)) return message;
    if (seenReminders.has(message.content)) return { role: "user", content: "" };
    seenReminders.add(message.content);
    return message;
  });
  const filtered = result.segments.map((segment) => ({
    ...segment,
    messages: segment.messages.filter((message) => !(message.role === "user" && typeof message.content === "string" && message.content === "")),
  }));
  return {
    ...result,
    segments: reindexSegments(filtered),
    messages: filtered.flatMap((segment) => segment.messages),
  };
}

function levelFour(view: ContextView): ContextView {
  const latest = view.segments.at(-1)?.id;
  const compacted = view.segments.filter((segment) => !segment.id.startsWith("facts:")).map((segment) => ({
    ...segment,
    // The current active segment is the highest-value continuation state. Keep
    // it byte-stable; only older attempts are structurally reduced.
    messages: segment.messages
      .filter((message) => !isFactsMessage(message))
      .map((message) => segment.id === latest ? message : shrinkMessage(message, 768)),
  }));
  const segments = reindexSegments([{
    id: `facts:${view.generation}`,
    eventRange: null,
    sourceSeqs: [],
    messageRange: [0, 1],
    messages: [factsMessage(view.facts)],
  }, ...compacted]);
  return {
    ...clone(view),
    segments,
    messages: segments.flatMap((segment) => segment.messages),
  };
}

function levelFive(view: ContextView): ContextView {
  const messages = view.messages.filter((message) => !isFactsMessage(message));
  if (messages.length <= 1) {
    return withMessages(view, [factsMessage(view.facts), ...messages.map((message) => shrinkMessage(message, 256))]);
  }
  const tail = messages.slice(-2).map((message) => shrinkMessage(message, 512));
  return withMessages(view, [factsMessage(view.facts), ...tail]);
}

function factsMessage(facts: readonly Fact[]): Message {
  if (facts.length === 0) return { role: "user", content: "[No pinned facts]" };
  return {
    role: "user",
    content: `[Pinned facts — verbatim, do not rewrite]\n${facts.map((fact) => `${fact.kind}: ${fact.text}`).join("\n")}`,
  };
}

function isFactsMessage(message: Message): boolean {
  return typeof message.content === "string"
    && (message.content.startsWith("[Pinned facts") || message.content === "[No pinned facts]");
}

function shrinkMessage(message: Message, maxChars: number): Message {
  if (typeof message.content === "string") return { ...message, content: preview(message.content, maxChars) };
  const content = message.content.map((block) => {
    if (block.type === "text") return { ...block, text: preview(block.text, maxChars) };
    if (block.type === "tool_result") return { ...block, content: preview(block.content, Math.min(maxChars, 256)) };
    return block;
  });
  return { ...message, content };
}

function mapBlocks(message: Message, transform: (block: ContentBlock) => ContentBlock): Message {
  return typeof message.content === "string" ? message : { ...message, content: message.content.map(transform) };
}

function reindexSegments(segments: readonly ContextSegment[]): ContextSegment[] {
  let cursor = 0;
  return segments.filter((segment) => segment.messages.length > 0).map((segment) => {
    const start = cursor;
    cursor += segment.messages.length;
    return { ...segment, messageRange: [start, cursor], messages: [...segment.messages] };
  });
}

async function applyProposal(
  view: ContextView,
  proposal: ContextProposal,
  archive: ContextArchive | undefined,
  sessionId: string,
): Promise<ContextView> {
  if (!proposal || typeof proposal !== "object") return view;
  const refs = [...view.archiveRefs];
  const latest = view.segments.at(-1)?.id;
  const segments: ContextSegment[] = [];
  for (const segment of view.segments) {
    const delta = proposal.segments?.find((candidate) => candidate.id === segment.id);
    if (!delta || delta.action === "keep" || delta.classification === "verified" || segment.id === latest) {
      segments.push(segment);
      continue;
    }
    const evidence = new Set(delta.evidenceRefs ?? []);
    if (evidence.size > 0 && ![...evidence].every((ref) => segment.sourceSeqs.some((seq) => ref.endsWith(`:${seq}`)))) {
      segments.push(segment);
      continue;
    }
    if (delta.action === "summarize" && delta.summary?.trim()) {
      const message: Message = { role: "user", content: `[Historical segment summary]\n${delta.summary.trim()}` };
      segments.push({ ...segment, messages: [message] });
      continue;
    }
    if (delta.action === "archive" && archive) {
      const content = JSON.stringify(segment.messages);
      const saved = await archive.put(content, { kind: "segment", sessionId, segmentId: segment.id });
      if (!refs.includes(saved.ref)) refs.push(saved.ref);
      const marker: Message = { role: "user", content: `[Historical segment archived: ${saved.ref}] ${saved.preview}` };
      segments.push({ ...segment, messages: [marker], sourceSeqs: [...segment.sourceSeqs] });
      continue;
    }
    segments.push(segment);
  }
  const state = mergeState(view.workingState, proposal.stateDelta);
  return {
    ...clone(view),
    segments: reindexSegments(segments),
    messages: segments.flatMap((segment) => segment.messages),
    workingState: state,
    archiveRefs: refs,
  };
}

function mergeState(
  current: readonly StateEntry[],
  delta: ContextProposal["stateDelta"],
): StateEntry[] {
  if (!delta) return [...current];
  const out = [...current];
  const add = (key: string, value: string) => {
    if (!value.trim() || out.some((entry) => entry.key === key && entry.value === value)) return;
    out.push({ key, value, evidenceRefs: [] });
  };
  for (const value of delta.decisions ?? []) add(`decision:${value}`, value);
  for (const value of delta.unresolved ?? []) add(`unresolved:${value}`, value);
  if (delta.nextStep) add("nextStep", delta.nextStep);
  return out;
}

async function plannerProposal(
  provider: ModelProvider,
  model: string,
  input: ContextPlannerInput,
  signal: AbortSignal,
): Promise<ContextProposal> {
  const req: ModelRequest = {
    model,
    system: "Return a JSON context proposal. Preserve facts; propose only additive segment/state deltas.",
    messages: [{ role: "user", content: JSON.stringify({ reason: input.reason, segments: input.candidates, facts: input.view.facts }) }],
  };
  let text = "";
  for await (const chunk of provider.stream(req, signal)) {
    if (chunk.type !== "message_done") continue;
    text = chunk.message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  const cleaned = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const parsed = JSON.parse(cleaned) as ContextProposal;
  return parsed && typeof parsed === "object" ? parsed : { segments: [], stateDelta: {} };
}

async function withTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("planner timeout");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("planner timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function estimateRequestTokens(req: ModelRequest): number {
  let tokens = estimateTokens(req.messages);
  if (req.system) tokens += Math.ceil(req.system.length / 4);
  if (req.tools) tokens += Math.ceil(JSON.stringify(req.tools).length / 4);
  return tokens;
}

function preview(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.max(1, Math.floor(maxChars * 0.7));
  const tail = Math.max(1, maxChars - head);
  return `${value.slice(0, head)}\n[… ${value.length - head - tail} chars omitted …]\n${value.slice(-tail)}`;
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = clone(item);
  return out as T;
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}
