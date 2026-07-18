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
  Redactor,
  Sandbox,
  Store,
  SteerController,
  Tool,
  ToolCallCodec,
  ToolChoice,
  BackgroundLimits,
  TokenEstimator,
} from "@lite-agent/core";
import type { FileToolsOptions } from "./tools/file";
import type { BashToolOptions } from "./tools/bash";
import type { ZodType } from "zod";
import { createLiteAgent } from "./createLiteAgent";
import type { LiteAgentResult } from "./createLiteAgent";
import type { ContextOptions } from "./liteAgent";

export interface QueryOptions {
  prompt: string | Message[];
  model: ModelProvider;
  modelName?: string;
  cwd?: string;
  systemPrompt?: string;
  skillsDir?: string;
  tools?: Tool[];
  codec?: ToolCallCodec;
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
  maxDecodeRetries?: number;
  use?: Middleware[];
  signal?: AbortSignal;
  sessionId?: string;
  steer?: SteerController;
  sandbox?: Sandbox;
  checkpointer?: Checkpointer;
  store?: Store;
  compactor?: Compactor | false;
  contextBudget?: { maxTokens: number; estimator?: TokenEstimator };
  context?: false | ContextOptions;
  home?: string;
  sessions?: boolean;
  spill?: boolean | { budgetBytes?: number };
  tasks?: boolean;
  taskListId?: string;
  agents?: boolean;
  agentsDir?: string;
  subagentPermission?: PermissionPolicy;
  background?: boolean;
  backgroundLimits?: BackgroundLimits;
  fileTools?: FileToolsOptions;
  bash?: BashToolOptions;
  crashRecovery?: "off" | "safe";
  maxSnapshotBytesPerSession?: number;
  cleanup?: boolean | { maxAgeDays?: number; maxBytes?: number };
  permission?: PermissionPolicy;
  redact?: Redactor;
  permissionMode?: "enforce" | "dry-run";
  /** Persist redacted permission decisions in the session event log. Default false. */
  permissionAudit?: boolean;
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
    codec: opts.codec,
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
    maxDecodeRetries: opts.maxDecodeRetries,
    use: opts.use,
    sandbox: opts.sandbox,
    checkpointer: opts.checkpointer,
    store: opts.store,
    compactor: opts.compactor,
    contextBudget: opts.contextBudget,
    context: opts.context,
    home: opts.home,
    sessions: opts.sessions,
    spill: opts.spill,
    tasks: opts.tasks,
    taskListId: opts.taskListId,
    agents: opts.agents,
    background: opts.background,
    backgroundLimits: opts.backgroundLimits,
    fileTools: opts.fileTools,
    bash: opts.bash,
    crashRecovery: opts.crashRecovery,
    maxSnapshotBytesPerSession: opts.maxSnapshotBytesPerSession,
    agentsDir: opts.agentsDir,
    subagentPermission: opts.subagentPermission,
    cleanup: opts.cleanup,
    permission: opts.permission,
    redact: opts.redact,
    permissionMode: opts.permissionMode,
    permissionAudit: opts.permissionAudit,
    onApproval: opts.onApproval,
    onAskUser: opts.onAskUser,
  });
  return (async function* () {
    const stream = agent.run(opts.prompt, {
      signal: opts.signal,
      sessionId: opts.sessionId,
      steer: opts.steer,
    });
    try {
      let next = await stream.next();
      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }
      return next.value;
    } finally {
      await agent.close();
    }
  })();
}
