import { AsyncLocalStorage } from "node:async_hooks";
import { abortable, policy } from "@lite-agent/core";
import type { AgentEvent, ToolCallContext } from "@lite-agent/core";
import { HOOK_NAMES } from "./types";
import type { CommandHook, HookEvent, HookHandler, HookName, HookOptions } from "./types";

export interface HookScope {
  runId: string;
  sessionId: string;
  agentId?: string;
  source: "user" | "background" | "manual";
  signal: AbortSignal;
  emit(event: AgentEvent): void;
  record?: ToolCallContext["recordSessionEvent"];
  compact?: { compactionId: string; kind: "micro" | "auto" | "manual"; before: number };
}

type Entry = { handler?: HookHandler<HookName>; command?: CommandHook; timeoutMs: number; label: string };

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

export class HookRegistry {
  private readonly entries = new Map<HookName, Entry[]>();
  private readonly invocations = new AsyncLocalStorage<{ active: boolean }>();
  private readonly scopes = new AsyncLocalStorage<HookScope>();
  private closed = false;
  private sequence = 0;

  constructor(commands: CommandHook[]) {
    for (const command of commands) this.add(command.event, { command, timeoutMs: command.timeoutMs, label: `${command.source}:${command.file}` });
  }

  register<N extends HookName>(name: N, handler: HookHandler<N>, opts: HookOptions = {}): () => void {
    if (this.closed) throw new Error("Agent is closed");
    if (!(HOOK_NAMES as readonly string[]).includes(name) || typeof handler !== "function") throw new TypeError("Invalid hook name or handler");
    const timeoutMs = opts.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new RangeError("Hook timeoutMs must be 1..120000");
    return this.add(name, { handler: handler as HookHandler<HookName>, timeoutMs, label: `programmatic:${++this.sequence}` });
  }

  private add(name: HookName, entry: Entry): () => void {
    const list = this.entries.get(name) ?? [];
    list.push(entry);
    this.entries.set(name, list);
    return () => { const index = list.indexOf(entry); if (index >= 0) list.splice(index, 1); };
  }

  withScope<T>(scope: HookScope, run: () => T): T { return this.scopes.run(scope, run); }
  get scope(): HookScope | undefined { return this.scopes.getStore(); }
  assertNotInHook(): void {
    if (this.invocations.getStore()?.active) throw new Error("A hook cannot await another run, maintenance, or close on the same agent family; schedule it after the hook returns");
  }
  stopRegistration(): void { this.closed = true; }
  clear(): void { this.closed = true; this.entries.clear(); }

  async dispatch(
    event: HookEvent, scope: HookScope,
    command: (entry: CommandHook, event: HookEvent, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const entries = [...(this.entries.get(event.event) ?? [])];
    if (!entries.length) return;
    const payload = freeze(structuredClone(event));
    for (const entry of entries) {
      if (entry.command?.match) {
        if (!("call" in payload)) continue;
        const matcher = policy({ allow: [entry.command.match], default: "deny" });
        if (await matcher.check({ id: "match", name: payload.call.name, input: {} }, { sessionId: scope.sessionId }) !== "allow") continue;
      }
      const controller = new AbortController();
      // Terminal callbacks still run on cancellation, with their own bounded cleanup signal.
      const terminal = event.event.endsWith(":end");
      const signal = terminal ? controller.signal : AbortSignal.any([controller.signal, scope.signal]);
      const timer = setTimeout(() => controller.abort(new Error("Hook timed out")), entry.timeoutMs);
      const invocation = { active: true };
      try {
        signal.throwIfAborted();
        await abortable(this.invocations.run(invocation, () => Promise.resolve().then(() => {
          signal.throwIfAborted();
          return entry.command ? command(entry.command, payload, signal) : entry.handler!(payload, { signal });
        })), signal);
      } catch (error) {
        scope.emit({ type: "diagnostic", level: "error", code: "hook_failed",
          message: `${event.event} (${entry.label}): ${controller.signal.aborted ? "Hook timed out" : error instanceof Error ? error.message : String(error)}` });
      } finally {
        invocation.active = false;
        clearTimeout(timer);
        controller.abort();
      }
    }
  }
}
