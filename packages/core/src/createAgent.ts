import { randomUUID } from "node:crypto";
import type { ModelProvider, Tool, ToolCallCodec, Sandbox, InputHandler, Store } from "./strategies";
import type { ToolChoice } from "./types";
import { noopSandbox } from "./sandbox";
import type { Middleware } from "./middleware";
import type { Message } from "./types";
import type { AgentEvent, RunResult } from "./events";
import { runKernel } from "./kernel";
import type { KernelConfig } from "./kernel";
import type { Checkpointer } from "./checkpoint";
import { legacyStoreAdapter } from "./checkpoint";

export interface CreateAgentConfig {
  model: ModelProvider;
  modelName?: string;
  codec: ToolCallCodec;
  tools?: Tool[];
  use?: Middleware[];
  system?: string;
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  toolChoice?: ToolChoice;
  seed?: number;
  sandbox?: Sandbox;
  input?: InputHandler;
  checkpointer?: Checkpointer;
  /** @deprecated pass `checkpointer`. A legacy Store is adapted automatically. */
  store?: Store;
  /** Max tool calls run concurrently per turn (default 10; 1 = sequential). */
  maxParallelTools?: number;
}

export type RunOptions = { signal?: AbortSignal; sessionId?: string };

export interface Agent {
  run(input: string | Message[], opts?: RunOptions): AsyncGenerator<AgentEvent, RunResult>;
  send(input: string | Message[], opts?: RunOptions): Promise<RunResult>;
}

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
    temperature: cfg.temperature,
    topP: cfg.topP,
    toolChoice: cfg.toolChoice,
    seed: cfg.seed,
    sandbox: cfg.sandbox ?? noopSandbox(),
    input: cfg.input,
    checkpointer: cfg.checkpointer ?? (cfg.store ? legacyStoreAdapter(cfg.store) : undefined),
    maxParallelTools: cfg.maxParallelTools,
  };

  const agent: Agent = {
    run(input, opts) {
      const signal = opts?.signal ?? new AbortController().signal;
      const sessionId = opts?.sessionId ?? randomUUID();
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
