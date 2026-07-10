import { randomBytes } from "node:crypto";
import pLimit from "p-limit";
import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, AgentEvent } from "@lite-agent/core";
import type { AgentLoader } from "../agents/loader";
import type { AgentDefinition } from "../agents/types";

/** Upper bound on concurrent child kernels per `Agent` call. */
const MAX_CONCURRENCY = 5;

export interface SpawnOptions {
  signal: AbortSignal;
  sessionId: string;
  /** Live child event sink. The Agent tool stamps each event with the child agentId. */
  onEvent?: (e: AgentEvent) => void;
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
      "Delegate a large or context-heavy subtask to a specialized subagent, keeping your own context clean. Each subagent runs in isolation (it sees only the `prompt` you pass) and returns only its final result. " +
      "By default this call BLOCKS until every subagent has finished and returns all their results directly (labeled `subagent[0]`, `subagent[1]`, …) — use this whenever you need the results to continue. " +
      "Pass `run_in_background: true` only for fire-and-forget fan-out you don't need immediately: it returns a placeholder now and the aggregated results are delivered later as a notification when all subagents finish (do NOT call `Agent` again to poll them). " +
      "To run subtasks in parallel, pass them as MULTIPLE entries in `tasks` within a SINGLE call — do not issue separate `Agent` calls for that. " +
      "To continue a previous subagent, pass its reported agentId as `resume`.",
    schema: z.object({
      tasks: z.array(TASK).min(1),
      run_in_background: z.boolean().optional().default(false),
    }),
    security: { network: "loopback", filesystem: "workspace", sideEffects: "workspace" },
    execute: async ({ tasks, run_in_background }, ctx) => {
      // Each entry in `tasks` is one subagent. Surface it as an ordinary tool
      // call (a tool_use + tool_result pair, paired by id) so any UI that already
      // renders tool calls shows N distinct subagents — no bespoke event type.
      // `signal`/`emit` default to the run-level ctx values (synchronous path). The
      // background path instead passes the task-scoped signal + run-level emit from
      // spawn, so subagent events survive after the spawning turn's channel has ended
      // and KillBackground can cancel the batch.
      const runBatch = async (
        signal: AbortSignal = ctx.signal,
        emit: (e: AgentEvent) => void = ctx.emit,
      ): Promise<string> => {
        const runOne = async (t: z.infer<typeof TASK>): Promise<{ id: string; out: string }> => {
          const name = t.subagent_type.replace(/[\r\n]+/g, " ");
          const def = loader.get(t.subagent_type);
          if (!def) {
            const id = `agent-${sanitize(t.subagent_type) || "unknown"}-${shortId()}`;
            const out = `Error: unknown subagent_type '${name}'. Available: ${
              loader.names().join(", ") || "(none)"
            }`;
            emit({ type: "tool_use", call: { id, name, input: { prompt: t.prompt } } });
            emit({ type: "tool_result", result: { id, name, content: out, isError: true } });
            return { id: "-", out };
          }
          const sessionId = t.resume
            ? sanitize(t.resume)
            : `agent-${sanitize(t.subagent_type)}-${shortId()}`;
          emit({ type: "tool_use", call: { id: sessionId, name, input: { prompt: t.prompt } } });
          try {
            const out = await spawn(def, t.prompt, {
              signal,
              sessionId,
              onEvent: (e) => emit({ ...e, agentId: sessionId }),
            });
            emit({ type: "tool_result", result: { id: sessionId, name, content: out } });
            return { id: sessionId, out };
          } catch (e) {
            const out = `Error: ${(e as Error).message}`;
            emit({ type: "tool_result", result: { id: sessionId, name, content: out, isError: true } });
            return { id: sessionId, out };
          }
        };

        const limit = pLimit(MAX_CONCURRENCY);
        const results = await Promise.all(tasks.map((t) => limit(() => runOne(t))));
        return results
          .map((r, i) => `## subagent[${i}] ${tasks[i]!.subagent_type.replace(/[\r\n]+/g, " ")} (agentId: ${r.id})\n${r.out}`)
          .join("\n\n");
      };

      // === true: blocking is the default, so a direct execute() call (bypassing schema
      // parse) that leaves this undefined must fall through to the blocking path.
      if (run_in_background === true && ctx.background) {
        const handle = ctx.background.spawn({
          label: `${tasks.length} subagent(s)`,
          kind: "joinable",
          run: (signal, emit) => runBatch(signal, emit),
        });
        return `[background:${handle.id}] dispatched ${tasks.length} subagent(s). Aggregated results will be delivered when all complete.`;
      }
      return runBatch();
    },
  });
}
