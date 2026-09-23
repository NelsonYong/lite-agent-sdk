import { randomUUID } from "node:crypto";
import { permission } from "@lite-agent/core";
import type { AgentEvent, Checkpointer, ToolCallContext } from "@lite-agent/core";
import type { RuntimeLiteAgentConfig } from "../liteAgent";
import { runProcess } from "../tools/bash";
import type { CommandHook, HookEvent } from "./types";

export async function runCommandHook(
  entry: CommandHook, event: HookEvent, signal: AbortSignal,
  cfg: RuntimeLiteAgentConfig, emit: (event: AgentEvent) => void,
  record?: ToolCallContext["recordSessionEvent"],
): Promise<void> {
  const stdin = JSON.stringify(event) + "\n";
  if (Buffer.byteLength(stdin) > 256 * 1024) throw new Error("Hook payload exceeds 256 KiB");
  const call = { id: `hook-${randomUUID()}`, name: "hook", input: {
    command: entry.command, event: entry.event, source: entry.source, configFile: entry.file,
  } };
  const ctx: ToolCallContext = {
    sessionId: event.sessionId, signal, call, emit, messages: [], turn: 0, state: new Map(), recordSessionEvent: record,
  };
  // Hook commands are a separate permission capability, not a model-visible tool.
  const gate = permission(cfg.permission!, cfg.onApproval, { audit: cfg.permissionAudit, redact: cfg.redact });
  const result = await gate.wrapToolCall!(ctx, async () => {
    signal.throwIfAborted();
    const command = cfg.sandbox ? await cfg.sandbox.wrap(entry.command, { cwd: cfg.workdir }) : entry.command;
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"])
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    const output = await runProcess(command, cfg.workdir, signal, {
      timeoutMs: entry.timeoutMs, maxOutputBytes: 64 * 1024, memoryBytes: cfg.bash?.memoryBytes,
      env: cfg.bash?.env ?? environment, stdin, rejectOnFailure: true,
    });
    return { id: call.id, name: call.name, content: output };
  });
  if (result.isError) throw new Error(result.content);
}

export function hookAudit(checkpointer: Checkpointer, sessionId: string): NonNullable<ToolCallContext["recordSessionEvent"]> {
  return async (event) => {
    const head = await checkpointer.head(sessionId);
    await checkpointer.append(sessionId, [event], head);
  };
}
