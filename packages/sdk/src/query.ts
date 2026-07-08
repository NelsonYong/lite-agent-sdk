import type {
  AgentEvent,
  ApprovalHandler,
  Checkpointer,
  Compactor,
  InputHandler,
  Message,
  Middleware,
  ModelProvider,
  PermissionPolicy,
  Sandbox,
  Store,
  SteerController,
  Tool,
  ToolChoice,
} from "@lite-agent/core";
import type { ZodType } from "zod";
import { createLiteAgent } from "./createLiteAgent";
import type { LiteAgentResult } from "./createLiteAgent";

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
  temperature?: number;
  topP?: number;
  toolChoice?: ToolChoice;
  seed?: number;
  outputSchema?: ZodType;
  maxParallelTools?: number;
  use?: Middleware[];
  signal?: AbortSignal;
  sessionId?: string;
  steer?: SteerController;
  sandbox?: Sandbox;
  checkpointer?: Checkpointer;
  store?: Store;
  compactor?: Compactor | false;
  home?: string;
  sessions?: boolean;
  spill?: boolean | { budgetBytes?: number };
  tasks?: boolean;
  taskListId?: string;
  agents?: boolean;
  background?: boolean;
  agentsDir?: string;
  subagentPermission?: PermissionPolicy;
  cleanup?: boolean | { maxAgeDays?: number };
  permission?: PermissionPolicy;
  onApproval?: ApprovalHandler;
  onAskUser?: InputHandler;
}

export function query(
  opts: QueryOptions,
): AsyncGenerator<AgentEvent, LiteAgentResult> {
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
    temperature: opts.temperature,
    topP: opts.topP,
    toolChoice: opts.toolChoice,
    seed: opts.seed,
    outputSchema: opts.outputSchema,
    maxParallelTools: opts.maxParallelTools,
    use: opts.use,
    sandbox: opts.sandbox,
    checkpointer: opts.checkpointer,
    store: opts.store,
    compactor: opts.compactor,
    home: opts.home,
    sessions: opts.sessions,
    spill: opts.spill,
    tasks: opts.tasks,
    taskListId: opts.taskListId,
    agents: opts.agents,
    background: opts.background,
    agentsDir: opts.agentsDir,
    subagentPermission: opts.subagentPermission,
    cleanup: opts.cleanup,
    permission: opts.permission,
    onApproval: opts.onApproval,
    onAskUser: opts.onAskUser,
  });
  return agent.run(opts.prompt, {
    signal: opts.signal,
    sessionId: opts.sessionId,
    steer: opts.steer,
  });
}
