import { randomBytes } from "node:crypto";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";
import type { AgentLoader } from "../agents/loader";
import type { AgentDefinition } from "../agents/types";

/** Upper bound on concurrent child kernels per `Agent` call. */
const MAX_CONCURRENCY = 5;

export interface SpawnOptions {
  signal: AbortSignal;
  sessionId: string;
}
export type Spawn = (
  def: AgentDefinition,
  prompt: string,
  opts: SpawnOptions,
) => Promise<string>;

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const shortId = () => randomBytes(4).toString("hex");

const TASK = z.object({
  subagent_type: z.string(),
  prompt: z.string(),
  description: z.string().optional(),
  resume: z.string().optional(),
});

export function agentTool(opts: { loader: AgentLoader; spawn: Spawn }): Tool {
  const { loader, spawn } = opts;
  return defineTool({
    name: "Agent",
    description:
      "Delegate a large or context-heavy subtask to a specialized subagent, keeping your own context clean. Each subagent runs in isolation (it sees only the `prompt` you pass) and returns only its final result. Pass MULTIPLE entries in `tasks` to run independent subtasks in parallel. To continue a previous subagent, pass its reported agentId as `resume`.",
    schema: z.object({ tasks: z.array(TASK).min(1) }),
    execute: async ({ tasks }, ctx) => {
      const runOne = async (t: z.infer<typeof TASK>): Promise<{ id: string; out: string }> => {
        const def = loader.get(t.subagent_type);
        if (!def) {
          return {
            id: "-",
            out: `Error: unknown subagent_type '${t.subagent_type.replace(/[\r\n]+/g, " ")}'. Available: ${
              loader.names().join(", ") || "(none)"
            }`,
          };
        }
        const sessionId = t.resume ?? `agent-${sanitize(t.subagent_type)}-${shortId()}`;
        try {
          const out = await spawn(def, t.prompt, { signal: ctx.signal, sessionId });
          return { id: sessionId, out };
        } catch (e) {
          return { id: sessionId, out: `Error: ${(e as Error).message}` };
        }
      };

      const results = await runPool(tasks, MAX_CONCURRENCY, runOne);
      return results
        .map((r, i) => `## subagent[${i}] ${tasks[i]!.subagent_type.replace(/[\r\n]+/g, " ")} (agentId: ${r.id})\n${r.out}`)
        .join("\n\n");
    },
  });
}

/** Run `fn` over `items` with at most `limit` in flight; results stay input-ordered. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
