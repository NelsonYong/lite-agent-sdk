import pLimit from "p-limit";
import type { ModelProvider, ToolCallCodec, Tool, Sandbox, InputHandler } from "./strategies";
import type { AssistantMessage, Message, ToolCall, ToolChoice, ToolResult, ToolResultBlock, Usage } from "./types";
import { isTextBlock, textBlock, toolResultBlock } from "./types";
import type { AgentEvent, RunResult } from "./events";
import { CodecError, ProviderError } from "./events";
import { composeModelCall, composeToolCall, runLifecycle } from "./middleware";
import type { AgentContext, Middleware, ToolCallContext } from "./middleware";
import { channel } from "./channel";
import { toToolSpec } from "./tools/define";
import type { Checkpointer, SessionEvent, StoredEvent } from "./checkpoint";
import { foldEvents } from "./checkpoint";
import type { SteerController } from "./steer";
import { createBackgroundTasks } from "./background";
import type { BackgroundCompletion, BackgroundLimits } from "./background";

export interface KernelConfig {
  provider: ModelProvider;
  codec: ToolCallCodec;
  tools: Tool[];
  middleware: Middleware[];
  model: string;
  system?: string;
  maxTurns: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  toolChoice?: ToolChoice;
  seed?: number;
  sandbox: Sandbox;
  input?: InputHandler;
  checkpointer?: Checkpointer;
  /** Max tool calls run concurrently within one assistant turn. Default 10; 1 = sequential. */
  maxParallelTools?: number;
  /** Optional turn-boundary steering queues (steer/followUp). */
  steer?: SteerController;
  /** Enable background tasks (default true). When false, ctx.background is undefined. */
  background?: boolean;
  backgroundLimits?: BackgroundLimits;
  maxDecodeRetries?: number;
  crashRecovery?: "off" | "safe";
  maxSnapshotBytesPerSession?: number;
}

export async function* runKernel(
  cfg: KernelConfig,
  input: string | Message[],
  signal: AbortSignal,
  sessionId: string,
): AsyncGenerator<AgentEvent, RunResult> {
  const inputMessages: Message[] = typeof input === "string" ? [{ role: "user", content: input }] : [...input];
  let messages: Message[];
  const cp = cfg.checkpointer;
  let head = 0;
  const history: SessionEvent[] = [];
  if (cp) {
    const stored: StoredEvent[] = [];
    for await (const e of cp.read(sessionId)) stored.push(e);
    history.push(...stored.map((s) => s.event));
    head = stored.length ? stored[stored.length - 1]!.seq : 0;
  }
  // Serialize appends so concurrent in-turn tool_result appends can't race `head`.
  let chain: Promise<void> = Promise.resolve();
  const append = (...evs: SessionEvent[]): Promise<void> => {
    if (!cp || evs.length === 0) return Promise.resolve();
    const p = chain.then(async () => { head = await cp.append(sessionId, evs, head); });
    chain = p.then(() => undefined, () => undefined);
    return p;
  };
  const recovered: Array<{ id: string; name: string; turn: number }> = [];
  if (cp && cfg.crashRecovery === "safe") {
    const pending = new Map<string, { id: string; name: string; turn: number }>();
    for (const event of history) {
      if (event.type === "tool_started") pending.set(event.id, event);
      else if (event.type === "tool_result") pending.delete(event.result.id);
    }
    recovered.push(...pending.values());
    const recoveryEvents = recovered.map(({ id, name, turn }): SessionEvent => ({
      type: "tool_result",
      result: toolResultBlock(id, `Error: interrupted before completion (${name})`, true),
      turn,
    }));
    await append(...recoveryEvents);
    history.push(...recoveryEvents);
  }
  messages = [...foldEvents(history), ...inputMessages];
  let snapshotBytes = history.reduce((total, event) => total + snapshotSize(event), 0);
  const queue: AgentEvent[] = [];
  const emit = (ev: AgentEvent) => { queue.push(ev); };
  for (const event of recovered) queue.push({ ...event, type: "tool_recovered" });
  const bg = cfg.background === false
    ? undefined
    : createBackgroundTasks({ emit, signal, limits: cfg.backgroundLimits });
  const toolMap = new Map(cfg.tools.map((t) => [t.name, t]));
  const toolSpecs = cfg.tools.map(toToolSpec);
  const state = new Map<string, unknown>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };

  function* drain(): Generator<AgentEvent> {
    while (queue.length) yield queue.shift()!;
  }
  const recordSessionEvent = cp ? (event: SessionEvent) => append(event) : undefined;
  const mkCtx = (turn: number): AgentContext => ({
    sessionId, messages, turn, signal, emit, recordSessionEvent, state,
  });

  try {
  await append(...inputMessages.map((m): SessionEvent => ({ type: "user", message: m })));

  await runLifecycle(cfg.middleware, "beforeAgent", mkCtx(0));
  yield* drain();

  let stopReason: RunResult["stopReason"] = "max_turns";

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    // Phase 1: abort is observed only at turn boundaries.
    if (signal.aborted) { bg?.cancelAll(); stopReason = "aborted"; break; }
    const ctx = mkCtx(turn);
    yield { type: "turn_start", turn };

    const steers = cfg.steer?.takeSteers() ?? [];
    if (steers.length) {
      ctx.messages.push(...steers);
      for (const m of steers) await append({ type: "user", message: m });
      yield { type: "steer", messages: steers };
    }

    if (bg) {
      for (const c of bg.takeCompleted()) {
        const note = backgroundNote(c);
        ctx.messages.push(note);
        await append({ type: "user", message: note });
        yield { type: "background_completed", completion: c };
      }
    }

    await runLifecycle(cfg.middleware, "beforeModel", ctx);
    yield* drain();
    messages = ctx.messages;

    let calls: ToolCall[] = [];
    let decodeAttempts = 0;
    while (true) {
      // Encode inside the ModelCall so middleware retries and codec repairs use
      // the current messages rather than a stale request snapshot.
      const modelCall = composeModelCall(cfg.middleware, ctx, () =>
        cfg.provider.stream(
          cfg.codec.encode(
            {
              model: cfg.model,
              system: cfg.system,
              messages: ctx.messages,
              maxTokens: cfg.maxTokens,
              temperature: cfg.temperature,
              topP: cfg.topP,
              toolChoice: cfg.toolChoice,
              seed: cfg.seed,
            },
            toolSpecs,
          ),
          signal,
        ),
      );

      let assistant: AssistantMessage | undefined;
      let callUsage: Usage | undefined;
      const modelStarted = Date.now();
      yield { type: "model_call_start", turn, model: cfg.model };
      try {
        for await (const chunk of modelCall()) {
          if (chunk.type === "text_delta") {
            if (cfg.codec.streaming !== "buffer") yield { type: "text_delta", text: chunk.text };
          } else {
            assistant = chunk.message;
            callUsage = chunk.usage;
            usage = {
              inputTokens: usage.inputTokens + chunk.usage.inputTokens,
              outputTokens: usage.outputTokens + chunk.usage.outputTokens,
            };
          }
        }
        if (!assistant) throw new ProviderError("provider produced no message_done chunk");
      } catch (error) {
        yield {
          type: "model_call_end", turn, model: cfg.model,
          durationMs: Date.now() - modelStarted,
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
      yield {
        type: "model_call_end", turn, model: cfg.model,
        durationMs: Date.now() - modelStarted,
        usage: callUsage,
      };
      messages = ctx.messages;
      yield* drain();

      let decoded: { text: string; calls: ToolCall[] };
      try {
        decoded = cfg.codec.decode(assistant);
      } catch (error) {
        if (!(error instanceof CodecError)) throw error;
        ctx.messages.push(assistant);
        yield { type: "message", message: assistant };
        await append({ type: "assistant", message: assistant });
        if (decodeAttempts >= (cfg.maxDecodeRetries ?? 2)) {
          yield { type: "error", error, fatal: true };
          throw error;
        }
        decodeAttempts++;
        yield { type: "error", error, fatal: false };
        const repair = cfg.codec.repairPrompt?.(error, decodeAttempts, toolSpecs) ?? {
          role: "user" as const,
          content: `Repair the malformed tool-call response and try again (${error.message}).`,
        };
        ctx.messages.push(repair);
        await append({ type: "user", message: repair });
        continue;
      }

      assistant = normalizedAssistant(decoded.text, decoded.calls);
      calls = decoded.calls;
      ctx.messages.push(assistant);
      if (cfg.codec.streaming === "buffer" && calls.length === 0 && decoded.text)
        yield { type: "text_delta", text: decoded.text };
      yield { type: "message", message: assistant };
      await append({ type: "assistant", message: assistant });
      break;
    }

    if (calls.length === 0) {
      const followUps = cfg.steer?.takeFollowUps() ?? [];
      if (followUps.length) {
        yield { type: "turn_end", turn, stopReason: "stop" };
        ctx.messages.push(...followUps);
        for (const m of followUps) await append({ type: "user", message: m });
        yield { type: "steer", messages: followUps };
        continue; // resurrect: keep looping instead of stopping
      }
      // Background join: the model is done, but background tasks are still running
      // or have undelivered results — so we DON'T stop. Block for the next
      // completion, then loop back to inject it (turn top) and let the model react.
      //
      // `turn--` rewinds the counter so the for-loop's `turn++` lands on the SAME
      // turn number: waiting on background work never burns the maxTurns budget.
      // Consequences to keep in mind when touching this:
      //   - Termination is bounded only by tasks settling (or run-abort /
      //     KillBackground). A task that never resolves AND ignores abort would
      //     block the run here forever — whole-run abort is the escape valve.
      //   - Total model-call count can exceed maxTurns, and the same turn number
      //     can repeat across join cycles, so turn numbers are NOT unique in the
      //     event stream. RunResult and the terminal `done` event remain the
      //     source of truth for consumers.
      if (bg && (bg.pendingJoinable() > 0 || bg.hasCompleted())) {
        yield { type: "turn_end", turn, stopReason: "stop" };
        if (!bg.hasCompleted()) await bg.waitNextJoinable(signal); // block until next completion or abort
        turn--;
        continue; // back to turn top → completions inject → model consumes
      }
      yield { type: "turn_end", turn, stopReason: "stop" };
      stopReason = "stop";
      break;
    }

    // All calls of this turn are now in flight: announce them up front, in input order.
    for (const call of calls) yield { type: "tool_use", call };

    // Tool-phase events stream LIVE into a channel (completion order), so concurrent
    // tools — and forwarded subagent events — surface in real time. The model-facing
    // user message is still assembled from `results[i]` in INPUT order: event timing
    // never changes what the model sees.
    const ch = channel<AgentEvent>();
    const results = new Array<ToolResult>(calls.length);

    const runCall = async (call: ToolCall, i: number): Promise<void> => {
      const callEmit = (ev: AgentEvent) => { ch.push(ev); };
      const recordSnapshot = cfg.checkpointer
        ? async (path: string, before: string | null, truncated?: boolean, encoding?: "utf8" | "base64") => {
            let event: SessionEvent = { type: "file_snapshot", path, before, truncated, encoding, turn };
            const size = snapshotSize(event);
            const limit = cfg.maxSnapshotBytesPerSession;
            if (!truncated && limit !== undefined && snapshotBytes + size > limit) {
              event = { type: "file_snapshot", path, before: null, truncated: true, turn };
            } else {
              snapshotBytes += size;
            }
            await append(event);
          }
        : undefined;
      const tctx: ToolCallContext = { ...ctx, call, emit: callEmit };
      const tool = toolMap.get(call.name);
      const baseExec = async (): Promise<ToolResult> => {
        if (!tool) return { id: call.id, name: call.name, content: `Error: unknown tool '${call.name}'`, isError: true };
        try {
          const parsed = tool.schema.parse(call.input);
          const out = await tool.execute(parsed, { sessionId, signal, emit: callEmit, sandbox: cfg.sandbox, input: cfg.input, call, recordSnapshot, background: bg });
          return { id: call.id, name: call.name, content: String(out) };
        } catch (e) {
          return { id: call.id, name: call.name, content: `Error: ${(e as Error).message}`, isError: true };
        }
      };
      if (cfg.crashRecovery === "safe")
        await append({ type: "tool_started", id: call.id, name: call.name, turn });
      const toolStarted = Date.now();
      ch.push({ type: "tool_call_start", call, turn });
      let result: ToolResult;
      try {
        result = await composeToolCall(cfg.middleware, tctx, baseExec)();
      } catch (e) {
        result = { id: call.id, name: call.name, content: `Error: ${(e as Error).message}`, isError: true };
      }
      await append({ type: "tool_result", result: toolResultBlock(result.id, result.content, result.isError), turn });
      results[i] = result;
      ch.push({
        type: "tool_call_end", id: result.id, name: result.name, turn,
        durationMs: Date.now() - toolStarted, isError: result.isError === true,
      });
      ch.push({ type: "tool_result", result });
    };

    const limit = pLimit(Math.max(1, cfg.maxParallelTools ?? 10));
    const pool = Promise.all(calls.map((call, i) => limit(() => runCall(call, i))));
    pool.then(() => ch.end(), (e) => ch.end(e as Error));
    for await (const ev of ch) yield ev;
    await pool;

    const resultBlocks: ToolResultBlock[] = results.map((r) =>
      toolResultBlock(r.id, r.content, r.isError),
    );
    ctx.messages.push({ role: "user", content: resultBlocks });
    yield { type: "turn_end", turn, stopReason: "tool_use" };
  }

  // Stop any tasks still running when the loop ends. On a normal `stop` exit the
  // join guarantees none are pending; this matters on the maxTurns exit, where
  // leaving them running would leak detached child processes / kernels.
  bg?.cancelAll();

  await runLifecycle(cfg.middleware, "afterAgent", mkCtx(0));
  yield* drain();

  const result: RunResult = { messages, text: lastAssistantText(messages), usage, stopReason };
  yield { type: "done", reason: stopReason, result };
  return result;
  } finally {
    bg?.cancelAll();
  }
}

function normalizedAssistant(text: string, calls: ToolCall[]): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [textBlock(text)] : []),
      ...calls.map((call) => ({ type: "tool_call" as const, ...call })),
    ],
  };
}

function snapshotSize(event: SessionEvent): number {
  if (event.type !== "file_snapshot" || event.before === null || event.truncated) return 0;
  return event.encoding === "base64"
    ? Buffer.from(event.before, "base64").byteLength
    : Buffer.byteLength(event.before, "utf8");
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && Array.isArray(m.content)) {
      return m.content.filter(isTextBlock).map((b) => b.text).join("");
    }
  }
  return "";
}

function backgroundNote(c: BackgroundCompletion): Message {
  const status = c.isError ? ' status="error"' : "";
  const label = c.label.replace(/"/g, "'"); // keep the label attribute well-formed
  return {
    role: "user",
    content: `<background-task-completed id="${c.id}" label="${label}"${status}>\n${c.content}\n</background-task-completed>`,
  };
}
