import { randomUUID } from "node:crypto";
import { estimateTokens } from "@lite-agent/core";
import type { AgentEvent, Compactor, Message, Middleware, RunOptions } from "@lite-agent/core";
import type { LiteAgentResult, RuntimeLiteAgentConfig } from "../liteAgent";
import { HookRegistry } from "./registry";
import type { HookScope } from "./registry";
import { hookAudit, runCommandHook } from "./commands";
import type { HookEvent, HookStatus } from "./types";
import type { Checkpointer } from "@lite-agent/core";

const errorInfo = (error: unknown) => ({ name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) });
const identity = (scope: HookScope) => ({ runId: scope.runId, sessionId: scope.sessionId, agentId: scope.agentId, source: scope.source });

export class HookRuntime {
  state?: Checkpointer;
  constructor(readonly registry: HookRegistry, private readonly cfg: RuntimeLiteAgentConfig, private readonly agentId?: string) {}

  private async dispatch(event: HookEvent, scope: HookScope): Promise<void> {
    try {
      await this.registry.dispatch(event, scope, (command, payload, signal) => runCommandHook(
        command, payload, signal, this.cfg, scope.emit,
        scope.record ?? (this.state ? hookAudit(this.state, scope.sessionId) : undefined),
      ));
    } catch (error) {
      scope.emit({ type: "diagnostic", level: "error", code: "hook_failed", message: `${event.event}: ${errorInfo(error).message}` });
    }
  }

  middleware(): Middleware {
    return {
      name: "sdk-hooks",
      beforeAgent: (ctx) => { const scope = this.registry.scope; if (scope) scope.record = ctx.recordSessionEvent; },
      wrapToolCall: async (ctx, next) => {
        const current = this.registry.scope;
        if (!current) return next();
        const scope = { ...current, emit: ctx.emit, record: ctx.recordSessionEvent };
        const started = Date.now();
        let result: Awaited<ReturnType<typeof next>> | undefined;
        let error: unknown;
        try {
          await this.dispatch({ ...identity(scope), event: "tool:start", call: ctx.call }, scope);
          ctx.signal.throwIfAborted();
          result = await next();
          return result;
        } catch (caught) { error = caught; throw caught; }
        finally {
          await this.dispatch({ ...identity(scope), event: "tool:end", call: ctx.call, result,
            status: ctx.signal.aborted ? "cancelled" : error || result?.isError ? "failed" : "completed",
            durationMs: Date.now() - started, ...(error === undefined ? {} : { error: errorInfo(error) }),
          }, scope);
        }
      },
    };
  }

  async *run(
    generator: AsyncGenerator<AgentEvent, LiteAgentResult>, input: string | Message[],
    opts: RunOptions & { sessionId: string }, takeOutput?: (id: string) => unknown,
    report?: (event: AgentEvent) => void,
  ): AsyncGenerator<AgentEvent, LiteAgentResult> {
    const diagnostics: AgentEvent[] = [];
    const scope: HookScope = { runId: randomUUID(), sessionId: opts.sessionId, agentId: this.agentId,
      source: opts.inputSource ?? "user", signal: opts.signal ?? new AbortController().signal,
      emit: (event) => diagnostics.push(event) };
    let result: LiteAgentResult | undefined;
    let failure: unknown;
    let status: HookStatus = "cancelled";
    let exhausted = false;
    try {
      await this.registry.withScope(scope, () => this.dispatch({ ...identity(scope), event: "run:start", input }, scope));
      yield* diagnostics.splice(0);
      scope.signal.throwIfAborted();
      let next = await this.registry.withScope(scope, () => generator.next());
      while (!next.done) {
        // The terminal event follows awaited run:end handlers, including structured output.
        if (next.value.type !== "done" || next.value.agentId) yield next.value;
        yield* diagnostics.splice(0);
        next = await this.registry.withScope(scope, () => generator.next());
      }
      exhausted = true;
      result = takeOutput ? { ...next.value, output: takeOutput(opts.sessionId) } : next.value;
      status = result.stopReason === "aborted" ? "cancelled" : result.stopReason === "max_turns" ? "max_turns" : "completed";
    } catch (error) { failure = error; status = scope.signal.aborted ? "cancelled" : "failed"; throw error; }
    finally {
      try {
        if (!exhausted) await this.registry.withScope(scope, () => generator.return(undefined as never));
      } finally {
        const summary = result ? { text: result.text, usage: result.usage, stopReason: result.stopReason, ...(result.output === undefined ? {} : { output: result.output }) } : undefined;
        await this.registry.withScope(scope, () => this.dispatch({ ...identity(scope), event: "run:end", status, result: summary,
          ...(failure === undefined ? {} : { error: errorInfo(failure) }),
        }, scope));
        if (!exhausted) for (const event of diagnostics.splice(0)) report?.(event);
      }
    }
    yield* diagnostics.splice(0);
    yield { type: "done", reason: result!.stopReason, result: result! };
    return result!;
  }

  async compaction(event: Extract<AgentEvent, { type: "compaction" }>): Promise<void> {
    const scope = this.registry.scope;
    if (!scope || scope.source === "manual") return;
    if (event.phase === "start") {
      scope.compact = { compactionId: randomUUID(), kind: event.kind, before: event.before };
      await this.dispatch({ ...identity(scope), ...scope.compact, event: "compact:start" }, scope);
    } else if (scope.compact && ["done", "error", "cancelled"].includes(event.phase ?? "")) {
      const compact = scope.compact;
      scope.compact = undefined;
      await this.dispatch({ ...identity(scope), ...compact, before: event.before, after: event.after, event: "compact:end",
        status: event.phase === "done" ? "completed" : event.phase === "cancelled" ? "cancelled" : "failed",
        ...(event.message ? { error: { name: "CompactionError", message: event.message } } : {}),
      }, scope);
    }
  }

  compactor(base: Compactor): Compactor {
    return { maybeCompact: async (messages, usage, instructions, signal) => {
      const before = estimateTokens(messages);
      await this.compaction({ type: "compaction", kind: "auto", phase: "start", before, after: before });
      try {
        signal?.throwIfAborted();
        const result = await base.maybeCompact(messages, usage, instructions, signal);
        await this.compaction({ type: "compaction", kind: result.kind ?? "auto", phase: "done", before, after: result.after ?? estimateTokens(result.messages) });
        return result;
      } catch (error) {
        await this.compaction({ type: "compaction", kind: "auto", phase: signal?.aborted ? "cancelled" : "error", before, after: before, message: errorInfo(error).message });
        throw error;
      }
    } };
  }

  manualCompact(
    sessionId: string, instructions: string | undefined, emit: (event: AgentEvent) => void, signal: AbortSignal,
    run: () => Promise<{ before: number; after: number }>,
  ): Promise<{ before: number; after: number }> {
    const scope: HookScope = { runId: randomUUID(), sessionId, agentId: this.agentId, source: "manual", signal, emit };
    return this.registry.withScope(scope, async () => {
      const compact = { compactionId: randomUUID(), kind: "manual" as const, before: 0 };
      let result: { before: number; after: number } | undefined;
      let failure: unknown;
      try {
        await this.dispatch({ ...identity(scope), ...compact, event: "compact:start", instructions }, scope);
        signal.throwIfAborted();
        result = await run();
        return result;
      } catch (error) { failure = error; throw error; }
      finally {
        await this.dispatch({ ...identity(scope), ...compact, before: result?.before ?? 0, after: result?.after ?? 0, event: "compact:end",
          status: signal.aborted ? "cancelled" : failure ? "failed" : "completed",
          ...(failure === undefined ? {} : { error: errorInfo(failure) }),
        }, scope);
      }
    });
  }
}
