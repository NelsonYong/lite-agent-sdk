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
      "This call is SYNCHRONOUS: it blocks until every subagent has finished, then returns all of their final results together (labeled `subagent[0]`, `subagent[1]`, …). " +
      "To run subtasks in parallel, pass them as MULTIPLE entries in `tasks` within a SINGLE call — do not issue separate `Agent` calls for that, and never call `Agent` again just to wait for or check on running subagents (they are already finished when this returns). " +
      "To continue a previous subagent, pass its reported agentId as `resume`.",
    schema: z.object({ tasks: z.array(TASK).min(1) }),
    execute: async ({ tasks }, ctx) => {
      // Each entry in `tasks` is one subagent. Surface it as an ordinary tool
      // call (a tool_use + tool_result pair, paired by id) so any UI that already
      // renders tool calls shows N distinct subagents — no bespoke event type.
      // These events are observational; the model still receives the single
      // aggregated string this tool returns. (To later drill into a subagent's
      // live progress, forward the child kernel's own event stream from `spawn`.)
      const runOne = async (t: z.infer<typeof TASK>): Promise<{ id: string; out: string }> => {
        const name = t.subagent_type.replace(/[\r\n]+/g, " ");
        const def = loader.get(t.subagent_type);
        if (!def) {
          const id = `agent-${sanitize(t.subagent_type) || "unknown"}-${shortId()}`;
          const out = `Error: unknown subagent_type '${name}'. Available: ${
            loader.names().join(", ") || "(none)"
          }`;
          ctx.emit({ type: "tool_use", call: { id, name, input: { prompt: t.prompt } } });
          ctx.emit({ type: "tool_result", result: { id, name, content: out, isError: true } });
          return { id: "-", out };
        }
        // Sanitize the resume handle too: keeps the reported agentId, the output
        // header, and the on-disk session key identical and filesystem-safe.
        const sessionId = t.resume
          ? sanitize(t.resume)
          : `agent-${sanitize(t.subagent_type)}-${shortId()}`;
        ctx.emit({ type: "tool_use", call: { id: sessionId, name, input: { prompt: t.prompt } } });
        try {
          const out = await spawn(def, t.prompt, {
            signal: ctx.signal,
            sessionId,
            onEvent: (e) => ctx.emit({ ...e, agentId: sessionId }),
          });
          ctx.emit({ type: "tool_result", result: { id: sessionId, name, content: out } });
          return { id: sessionId, out };
        } catch (e) {
          const out = `Error: ${(e as Error).message}`;
          ctx.emit({ type: "tool_result", result: { id: sessionId, name, content: out, isError: true } });
          return { id: sessionId, out };
        }
      };

      const limit = pLimit(MAX_CONCURRENCY);
      const results = await Promise.all(tasks.map((t) => limit(() => runOne(t))));
      return results
        .map((r, i) => `## subagent[${i}] ${tasks[i]!.subagent_type.replace(/[\r\n]+/g, " ")} (agentId: ${r.id})\n${r.out}`)
        .join("\n\n");
    },
  });
}
