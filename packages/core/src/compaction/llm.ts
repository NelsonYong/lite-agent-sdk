import type { Compactor, ModelProvider } from "../strategies";
import type { Message, ModelRequest } from "../types";
import { isTextBlock } from "../types";
import { estimateTokens } from "./types";
import { splitTurns } from "./snip";
import { defaultCompactor } from "./defaultCompactor";

const DEFAULT_SUMMARY_PROMPT =
  "You are a context-compaction assistant. Summarize the conversation so far into a concise note that preserves key facts, decisions, file paths, and the current task state. Output only the summary.";

export interface LlmCompactorOptions {
  provider: ModelProvider;
  model: string;
  /** Deterministic compactor run first. Default defaultCompactor(). */
  base?: Compactor;
  /** Summarize via the LLM once the estimate exceeds this. Default 120_000. */
  tokenThreshold?: number;
  /** Recent turns kept verbatim; older ones get summarized. Default 3. */
  keepRecentTurns?: number;
  summaryPrompt?: string;
  /** Consecutive LLM failures before the circuit opens (falls back to base). Default 2. */
  maxFailures?: number;
}

// L4 autoCompact: an LLM-summary Compactor. Runs a deterministic base first,
// then — only if still over the token threshold — summarizes the older turns
// into one message via a single model call, keeping recent turns verbatim
// (turn-aligned, so pairing stays intact). A circuit breaker disables the LLM
// after repeated failures so compaction can never wedge the run. Same Compactor
// interface as defaultCompactor — fully swappable.
export function llmCompactor(opts: LlmCompactorOptions): Compactor {
  const base = opts.base ?? defaultCompactor();
  const threshold = opts.tokenThreshold ?? 120_000;
  const keepRecentTurns = opts.keepRecentTurns ?? 3;
  const summaryPrompt = opts.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;
  const maxFailures = opts.maxFailures ?? 2;
  let failures = 0;
  let circuitOpen = false;

  async function summarize(older: Message[]): Promise<string> {
    const req: ModelRequest = {
      model: opts.model,
      system: summaryPrompt,
      messages: [...older, { role: "user", content: "Summarize the conversation above as instructed." }],
    };
    let assistant: Message | undefined;
    for await (const chunk of opts.provider.stream(req)) {
      if (chunk.type === "message_done") assistant = chunk.message;
    }
    if (!assistant || !Array.isArray(assistant.content)) return "";
    return assistant.content.filter(isTextBlock).map((b) => b.text).join("").trim();
  }

  return {
    async maybeCompact(messages, usage) {
      const before = estimateTokens(messages);
      const baseResult = await base.maybeCompact(messages, usage);
      const msgs = baseResult.messages;

      if (circuitOpen || estimateTokens(msgs) <= threshold) {
        return { ...baseResult, before, after: estimateTokens(msgs) };
      }
      const turns = splitTurns(msgs);
      if (turns.length <= keepRecentTurns + 1) {
        return { messages: msgs, kind: baseResult.kind, before, after: estimateTokens(msgs) };
      }
      const recent = turns.slice(turns.length - keepRecentTurns).flat();
      const older = turns.slice(0, turns.length - keepRecentTurns).flat();
      try {
        const summary = await summarize(older);
        failures = 0;
        const summaryMsg: Message = { role: "user", content: `[Summary of earlier conversation]\n${summary}` };
        const out = [summaryMsg, ...recent];
        return { messages: out, kind: "auto", before, after: estimateTokens(out) };
      } catch {
        failures++;
        if (failures >= maxFailures) circuitOpen = true;
        return { messages: msgs, kind: baseResult.kind, before, after: estimateTokens(msgs) };
      }
    },
  };
}
