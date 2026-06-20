import type { AgentEvent, ApprovalHandler, Message, Middleware, ModelProvider, PermissionPolicy, RunResult, Sandbox, Tool } from "@lite-agent/core";
import { createLiteAgent } from "./createLiteAgent";

export interface QueryOptions {
  prompt: string | Message[];
  model: ModelProvider;
  modelName?: string;
  cwd?: string;
  systemPrompt?: string;
  skillsDir?: string;
  tools?: Tool[];
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  use?: Middleware[];
  signal?: AbortSignal;
  sessionId?: string;
  sandbox?: Sandbox;
  permission?: PermissionPolicy;
  onApproval?: ApprovalHandler;
}

export function query(opts: QueryOptions): AsyncGenerator<AgentEvent, RunResult> {
  const agent = createLiteAgent({
    model: opts.model,
    modelName: opts.modelName,
    workdir: opts.cwd ?? process.cwd(),
    skillsDir: opts.skillsDir,
    tools: opts.tools,
    system: opts.systemPrompt,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    maxTurns: opts.maxTurns,
    maxTokens: opts.maxTokens,
    use: opts.use,
    sandbox: opts.sandbox,
    permission: opts.permission,
    onApproval: opts.onApproval,
  });
  return agent.run(opts.prompt, { signal: opts.signal, sessionId: opts.sessionId });
}
