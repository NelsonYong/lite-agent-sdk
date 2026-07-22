import { sweepStale } from "./cleanup";
import { resolveProjectPaths } from "./paths";
import { assembleLiteAgent } from "./liteAgentAssembly";
import { createLiteAgentFacade } from "./liteAgent";
import type { CreateLiteAgentConfig, LiteAgent, LiteAgentResult, RuntimeLiteAgentConfig } from "./liteAgent";
import { createSessionRunner } from "./sessionRunner";
import { createSubagentPool } from "./subagentPool";
import type { Spawn, SubagentResult } from "./tools/agent";

export type {
  CreateLiteAgentConfig,
  ContextOptions,
  LiteAgent,
  LiteAgentEvent,
  LiteAgentResult,
} from "./liteAgent";

export function createLiteAgent(cfg: CreateLiteAgentConfig): LiteAgent {
  const paths = resolveProjectPaths({
    workdir: cfg.workdir,
    home: cfg.home,
  });

  if (cfg.cleanup !== false) {
    sweepStale({
      home: paths.home,
      maxAgeDays:
        typeof cfg.cleanup === "object"
          ? cfg.cleanup.maxAgeDays
          : undefined,
      maxBytes:
        typeof cfg.cleanup === "object"
          ? cfg.cleanup.maxBytes
          : undefined,
    });
  }

  const subagentPool = createSubagentPool(cfg.maxParallelSubagents ?? 5);
  const sessions = createSessionRunner<LiteAgentResult>({
    background: cfg.background !== false,
    limits: cfg.backgroundLimits,
    waitForBackgroundIdle: (sessionId) => subagentPool.waitForIdle(sessionId),
  });

  const spawn: Spawn = async (
    definition,
    prompt,
    { signal, sessionId, onEvent },
  ) => {
    const child = createLiteAgent({
      ...cfg,
      system:
        `You are the "${definition.name}" subagent operating in ${cfg.workdir}. ` +
        `Return your final answer as your last message.\n\n${definition.body}`,
      modelName: definition.model ?? cfg.modelName,
      allowedTools: definition.tools ?? cfg.allowedTools,
      agents: false,
      // A caller may provide a custom dispatcher named `Agent`. It must not
      // leak into the isolated child and reintroduce recursive subagents.
      tools: cfg.tools?.filter((tool) => tool.name !== "Agent"),
      cleanup: false,
      permission: cfg.subagentPermission,
      onApproval: undefined,
      onAskUser: undefined,
      outputSchema: undefined,
      checkpointer: cfg.checkpointer,
    });
    try {
      const gen = child.run(
        [{ role: "user", content: prompt }],
        { signal, sessionId },
      );
      let result = await gen.next();
      while (!result.done) {
        onEvent?.(result.value);
        result = await gen.next();
      }
      const { text, stopReason } = result.value;
      if (stopReason === "aborted") {
        return { status: "cancelled", error: "Subagent aborted", stopReason };
      }
      if (stopReason === "max_turns") {
        return { status: "failed", error: "Subagent reached max turns", stopReason };
      }
      if (!text.trim()) {
        return { status: "failed", error: "Subagent stopped without a final answer", stopReason };
      }
      return { status: "completed", text, stopReason };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: SubagentResult = signal.aborted
        ? { status: "cancelled", error: message, stopReason: "aborted" }
        : { status: "failed", error: message };
      return result;
    } finally {
      await child.close();
    }
  };

  const runtime = assembleLiteAgent({
    cfg: cfg as RuntimeLiteAgentConfig,
    paths,
    spawn,
    subagentPool,
    backgroundTasks: (sessionId) => sessions.backgroundTasks(sessionId),
  });
  return createLiteAgentFacade(runtime, cfg.workdir, sessions, () => subagentPool.close());
}
