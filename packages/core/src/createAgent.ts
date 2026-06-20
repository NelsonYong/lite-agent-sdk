import type { ModelProvider, Tool, ToolCallCodec, Sandbox, InputHandler } from "./strategies";
import { noopSandbox } from "./sandbox";
import type { Middleware } from "./middleware";
import type { Message } from "./types";
import type { AgentEvent, RunResult } from "./events";
import { runKernel } from "./kernel";
import type { KernelConfig } from "./kernel";

export interface CreateAgentConfig {
  model: ModelProvider;
  modelName?: string;
  codec: ToolCallCodec;
  tools?: Tool[];
  use?: Middleware[];
  system?: string;
  maxTurns?: number;
  maxTokens?: number;
  sandbox?: Sandbox;
  input?: InputHandler;
}

export type RunOptions = { signal?: AbortSignal; sessionId?: string };

export interface Agent {
  run(input: string | Message[], opts?: RunOptions): AsyncGenerator<AgentEvent, RunResult>;
  send(input: string | Message[], opts?: RunOptions): Promise<RunResult>;
}

let sessionCounter = 0;

export function createAgent(cfg: CreateAgentConfig): Agent {
  const kernelCfg: KernelConfig = {
    provider: cfg.model,
    codec: cfg.codec,
    tools: cfg.tools ?? [],
    middleware: cfg.use ?? [],
    model: cfg.modelName ?? cfg.model.id,
    system: cfg.system,
    maxTurns: cfg.maxTurns ?? 50,
    maxTokens: cfg.maxTokens,
    sandbox: cfg.sandbox ?? noopSandbox(),
    input: cfg.input,
  };

  const agent: Agent = {
    run(input, opts) {
      const signal = opts?.signal ?? new AbortController().signal;
      const sessionId = opts?.sessionId ?? `s${++sessionCounter}`;
      return runKernel(kernelCfg, input, signal, sessionId);
    },
    async send(input, opts) {
      const gen = agent.run(input, opts);
      let r = await gen.next();
      while (!r.done) r = await gen.next();
      return r.value;
    },
  };
  return agent;
}
