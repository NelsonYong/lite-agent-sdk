import { sweepStale } from "./cleanup";
import { resolveProjectPaths } from "./paths";
import { assembleLiteAgent } from "./liteAgentAssembly";
import { createLiteAgentFacade } from "./liteAgent";
import type { CreateLiteAgentConfig, LiteAgent, LiteAgentResult } from "./liteAgent";
import { createSessionRunner } from "./sessionRunner";
import type { Spawn } from "./tools/agent";

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

  const sessions = createSessionRunner<LiteAgentResult>({
    background: cfg.background !== false,
    limits: cfg.backgroundLimits,
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
      return result.value.text;
    } finally {
      await child.close();
    }
  };

  const runtime = assembleLiteAgent({
    cfg,
    paths,
    spawn,
    backgroundTasks: (sessionId) => sessions.backgroundTasks(sessionId),
  });
  return createLiteAgentFacade(runtime, cfg.workdir, sessions);
}
