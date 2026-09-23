import type { AgentEvent, Message, SteerController } from "@lite-agent/core";
import { createLiteAgent } from "./createLiteAgent";
import type { CreateLiteAgentConfig, LiteAgentResult } from "./createLiteAgent";

export interface QueryOptions extends Omit<CreateLiteAgentConfig, "workdir"> {
  prompt: string | Message[];
  workdir?: string;
  /** @deprecated Use workdir, matching createLiteAgent. */
  cwd?: string;
  /** @deprecated Use system, matching createLiteAgent. */
  systemPrompt?: string;
  signal?: AbortSignal;
  sessionId?: string;
  steer?: SteerController;
}

export function query(
  opts: QueryOptions,
): AsyncGenerator<AgentEvent, LiteAgentResult> {
  if (opts.workdir !== undefined && opts.cwd !== undefined && opts.workdir !== opts.cwd)
    throw new Error("query: workdir and cwd conflict");
  if (opts.system !== undefined && opts.systemPrompt !== undefined && opts.system !== opts.systemPrompt)
    throw new Error("query: system and systemPrompt conflict");
  const { prompt: _prompt, cwd, systemPrompt, signal: _signal, sessionId: _sessionId, steer: _steer, ...config } = opts;
  const agent = createLiteAgent({
    ...config,
    workdir: opts.workdir ?? cwd ?? process.cwd(),
    system: opts.system ?? systemPrompt,
  });
  return (async function* () {
    const sessionId = opts.sessionId ?? agent.sessionId;
    const backgroundEvents: AgentEvent[] = [];
    const unsubscribe = agent.subscribe((entry) => {
      if (entry.sessionId === sessionId && entry.source === "background") {
        backgroundEvents.push(entry.event);
      }
    });
    const stream = agent.run(opts.prompt, {
      signal: opts.signal,
      sessionId,
      steer: opts.steer,
    });
    try {
      let agentGroupObserved = false;
      let next = await stream.next();
      while (!next.done) {
        if (next.value.type === "tool_use" && next.value.call.name === "Agent") {
          agentGroupObserved = true;
        }
        yield next.value;
        next = await stream.next();
      }
      const initialResult = next.value;
      let cursor = 0;
      let completionTurnHasAgentGroup = false;
      let lastAgentCompletionResult: LiteAgentResult | undefined;
      const drainBackgroundEvents = function* () {
        while (cursor < backgroundEvents.length) {
          const event = backgroundEvents[cursor++]!;
          if (event.type === "tool_use" && event.call.name === "Agent") {
            agentGroupObserved = true;
          } else if (
            event.type === "background_completed" &&
            agentGroupObserved &&
            event.completion.label.startsWith("Subagent group:")
          ) {
            completionTurnHasAgentGroup = true;
          } else if (event.type === "done" && !event.agentId) {
            if (completionTurnHasAgentGroup) {
              lastAgentCompletionResult = event.result;
              completionTurnHasAgentGroup = false;
            }
          } else if (event.type === "error" && !event.agentId) {
            completionTurnHasAgentGroup = false;
          }
          yield event;
        }
      };

      yield* drainBackgroundEvents();
      // A one-shot query only owns Agent groups it submitted. Detached daemons
      // (for example, background bash) must not turn into an extra completion
      // turn or extend the query lifetime.
      if (agentGroupObserved) {
        const signal = opts.signal;
        if (!signal) {
          await agent.awaitIdle(sessionId);
        } else if (!signal.aborted) {
          let resolveAbort!: () => void;
          const aborted = new Promise<void>((resolve) => { resolveAbort = resolve; });
          const onAbort = () => resolveAbort();
          signal.addEventListener("abort", onAbort, { once: true });
          // Abort can race the `signal.aborted` check above. Re-check after
          // registration so an abort in that window cannot leave query waiting.
          if (signal.aborted) resolveAbort();
          try {
            await Promise.race([agent.awaitIdle(sessionId), aborted]);
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        }
      }
      yield* drainBackgroundEvents();
      return lastAgentCompletionResult ?? initialResult;
    } finally {
      unsubscribe();
      await agent.close();
    }
  })();
}
