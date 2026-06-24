import type {
  AgentEvent,
  ApprovalHandler,
  Compactor,
  InputHandler,
  Message,
  Middleware,
  ModelProvider,
  PermissionPolicy,
  RunResult,
  Sandbox,
  Store,
  Tool,
} from "@lite-agent/core";
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
  store?: Store;
  compactor?: Compactor | false;
  home?: string;
  sessions?: boolean;
  spill?: boolean | { budgetBytes?: number };
  tasks?: boolean;
  taskListId?: string;
  cleanup?: boolean | { maxAgeDays?: number };
  permission?: PermissionPolicy;
  onApproval?: ApprovalHandler;
  onAskUser?: InputHandler;
}

export function query(
  opts: QueryOptions,
): AsyncGenerator<AgentEvent, RunResult> {
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
    store: opts.store,
    compactor: opts.compactor,
    home: opts.home,
    sessions: opts.sessions,
    spill: opts.spill,
    tasks: opts.tasks,
    taskListId: opts.taskListId,
    cleanup: opts.cleanup,
    permission: opts.permission,
    onApproval: opts.onApproval,
    onAskUser: opts.onAskUser,
  });
  return agent.run(opts.prompt, {
    signal: opts.signal,
    sessionId: opts.sessionId,
  });
}
