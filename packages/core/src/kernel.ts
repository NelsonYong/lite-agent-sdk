import pLimit from "p-limit";
import type { ModelProvider, ToolCallCodec, Tool, Sandbox, InputHandler } from "./strategies";
import type { AssistantMessage, Message, ToolCall, ToolChoice, ToolResult, ToolResultBlock, Usage } from "./types";
import { isTextBlock, toolResultBlock } from "./types";
import type { AgentEvent, RunResult } from "./events";
import { ProviderError } from "./events";
import { composeModelCall, composeToolCall, runLifecycle } from "./middleware";
import type { AgentContext, Middleware, ToolCallContext } from "./middleware";
import { toToolSpec } from "./tools/define";
import type { Checkpointer, SessionEvent, StoredEvent } from "./checkpoint";
import { foldEvents } from "./checkpoint";

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
}

export async function* runKernel(
  cfg: KernelConfig,
  input: string | Message[],
  signal: AbortSignal,
  sessionId: string,
): AsyncGenerator<AgentEvent, RunResult> {
  const inputMessages: Message[] = typeof input === "string" ? [{ role: "user", content: input }] : [...input];
  let messages: Message[] = inputMessages;
  const cp = cfg.checkpointer;
  let head = 0;
  if (cp) {
    const stored: StoredEvent[] = [];
    for await (const e of cp.read(sessionId)) stored.push(e);
    messages = [...foldEvents(stored.map((s) => s.event)), ...inputMessages];
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
  const queue: AgentEvent[] = [];
  const emit = (ev: AgentEvent) => { queue.push(ev); };
  const toolMap = new Map(cfg.tools.map((t) => [t.name, t]));
  const toolSpecs = cfg.tools.map(toToolSpec);
  const state = new Map<string, unknown>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };

  function* drain(): Generator<AgentEvent> {
    while (queue.length) yield queue.shift()!;
  }
  const mkCtx = (turn: number): AgentContext => ({ sessionId, messages, turn, signal, emit, state });

  await append(...inputMessages.map((m): SessionEvent => ({ type: "user", message: m })));

  await runLifecycle(cfg.middleware, "beforeAgent", mkCtx(0));
  yield* drain();

  let stopReason: RunResult["stopReason"] = "max_turns";

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    // Phase 1: abort is observed only at turn boundaries.
    if (signal.aborted) { stopReason = "aborted"; break; }
    const ctx = mkCtx(turn);
    yield { type: "turn_start", turn };

    await runLifecycle(cfg.middleware, "beforeModel", ctx);
    yield* drain();
    messages = ctx.messages;

    // Encode inside the ModelCall so each (re)invocation reflects the CURRENT
    // ctx.messages — lets a wrapModelCall middleware mutate messages and retry
    // (e.g. reactive compaction on prompt_too_long) against the new context.
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
    for await (const chunk of modelCall()) {
      if (chunk.type === "text_delta") yield { type: "text_delta", text: chunk.text };
      else {
        assistant = chunk.message;
        usage = {
          inputTokens: usage.inputTokens + chunk.usage.inputTokens,
          outputTokens: usage.outputTokens + chunk.usage.outputTokens,
        };
      }
    }
    messages = ctx.messages; // re-sync: a wrapModelCall middleware may have replaced ctx.messages (e.g. reactive compaction)
    yield* drain();
    if (!assistant) throw new ProviderError("provider produced no message_done chunk");

    ctx.messages.push(assistant);
    yield { type: "message", message: assistant };
    await append({ type: "assistant", message: assistant });

    const { calls } = cfg.codec.decode(assistant);
    if (calls.length === 0) {
      yield { type: "turn_end", turn, stopReason: "stop" };
      stopReason = "stop";
      break;
    }

    // All calls of this turn are now in flight: announce them up front, in input order.
    for (const call of calls) yield { type: "tool_use", call };

    // Each call runs with an ISOLATED emit buffer so a sibling's events (approval_*,
    // tool emits) don't interleave non-deterministically. Buffers flush in input order
    // after the pool drains, so the event stream stays deterministic.
    const runCall = async (
      call: ToolCall,
    ): Promise<{ events: AgentEvent[]; result: ToolResult }> => {
      const events: AgentEvent[] = [];
      const callEmit = (ev: AgentEvent) => { events.push(ev); };
      const tctx: ToolCallContext = { ...ctx, call, emit: callEmit };
      const tool = toolMap.get(call.name);
      const baseExec = async (): Promise<ToolResult> => {
        if (!tool) return { id: call.id, name: call.name, content: `Error: unknown tool '${call.name}'`, isError: true };
        try {
          const parsed = tool.schema.parse(call.input);
          const out = await tool.execute(parsed, { sessionId, signal, emit: callEmit, sandbox: cfg.sandbox, input: cfg.input, call });
          return { id: call.id, name: call.name, content: String(out) };
        } catch (e) {
          return { id: call.id, name: call.name, content: `Error: ${(e as Error).message}`, isError: true };
        }
      };
      let result: ToolResult;
      try {
        result = await composeToolCall(cfg.middleware, tctx, baseExec)();
      } catch (e) {
        // A wrapToolCall middleware that throws (rather than returning an isError
        // result) must not strand sibling calls or surface as an unhandled rejection
        // under concurrency. Convert to an error result so runCall never rejects.
        result = { id: call.id, name: call.name, content: `Error: ${(e as Error).message}`, isError: true };
      }
      await append({ type: "tool_result", result: toolResultBlock(result.id, result.content, result.isError), turn });
      return { events, result };
    };

    const limit = pLimit(Math.max(1, cfg.maxParallelTools ?? 10));
    const outcomes = await Promise.all(calls.map((call) => limit(() => runCall(call))));

    const resultBlocks: ToolResultBlock[] = [];
    for (const { events, result } of outcomes) {
      for (const ev of events) yield ev;
      resultBlocks.push(toolResultBlock(result.id, result.content, result.isError));
      yield { type: "tool_result", result };
    }
    ctx.messages.push({ role: "user", content: resultBlocks });
    yield { type: "turn_end", turn, stopReason: "tool_use" };
  }

  await runLifecycle(cfg.middleware, "afterAgent", mkCtx(0));
  yield* drain();

  const result: RunResult = { messages, text: lastAssistantText(messages), usage, stopReason };
  yield { type: "done", reason: stopReason, result };
  return result;
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
