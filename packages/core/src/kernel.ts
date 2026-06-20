import type { ModelProvider, ToolCallCodec, Tool, Sandbox, InputHandler } from "./strategies";
import type { AssistantMessage, Message, ToolResultBlock, Usage } from "./types";
import { isTextBlock, toolResultBlock } from "./types";
import type { AgentEvent, RunResult } from "./events";
import { ProviderError } from "./events";
import { composeModelCall, composeToolCall, runLifecycle } from "./middleware";
import type { AgentContext, Middleware, ToolCallContext } from "./middleware";
import { toToolSpec } from "./tools/define";

export interface KernelConfig {
  provider: ModelProvider;
  codec: ToolCallCodec;
  tools: Tool[];
  middleware: Middleware[];
  model: string;
  system?: string;
  maxTurns: number;
  maxTokens?: number;
  sandbox: Sandbox;
  input?: InputHandler;
}

export async function* runKernel(
  cfg: KernelConfig,
  input: string | Message[],
  signal: AbortSignal,
  sessionId: string,
): AsyncGenerator<AgentEvent, RunResult> {
  let messages: Message[] = typeof input === "string" ? [{ role: "user", content: input }] : [...input];
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

    const req = cfg.codec.encode(
      { model: cfg.model, system: cfg.system, messages: ctx.messages, maxTokens: cfg.maxTokens },
      toolSpecs,
    );
    const modelCall = composeModelCall(cfg.middleware, ctx, () => cfg.provider.stream(req, signal));

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
    yield* drain();
    if (!assistant) throw new ProviderError("provider produced no message_done chunk");

    ctx.messages.push(assistant);
    yield { type: "message", message: assistant };

    const { calls } = cfg.codec.decode(assistant);
    if (calls.length === 0) {
      yield { type: "turn_end", turn, stopReason: "stop" };
      stopReason = "stop";
      break;
    }

    const resultBlocks: ToolResultBlock[] = [];
    for (const call of calls) {
      yield { type: "tool_use", call };
      const tctx: ToolCallContext = { ...ctx, call };
      const tool = toolMap.get(call.name);
      const baseExec = async () => {
        if (!tool) return { id: call.id, name: call.name, content: `Error: unknown tool '${call.name}'`, isError: true as const };
        try {
          const parsed = tool.schema.parse(call.input);
          const out = await tool.execute(parsed, { sessionId, signal, emit, sandbox: cfg.sandbox, input: cfg.input, call });
          return { id: call.id, name: call.name, content: String(out) };
        } catch (e) {
          return { id: call.id, name: call.name, content: `Error: ${(e as Error).message}`, isError: true as const };
        }
      };
      const result = await composeToolCall(cfg.middleware, tctx, baseExec)();
      yield* drain();
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
