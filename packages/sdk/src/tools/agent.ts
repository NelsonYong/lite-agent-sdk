import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AbortError, defineTool } from "@lite-agent/core";
import type { AgentEvent, BackgroundRunResult, Tool } from "@lite-agent/core";
import type { AgentLoader } from "../agents/loader";
import type { AgentDefinition } from "../agents/types";
import { createSubagentPool } from "../subagentPool";
import type { SubagentPool } from "../subagentPool";

export type SubagentStatus = "completed" | "failed" | "cancelled";

export interface SubagentResult {
  status: SubagentStatus;
  text?: string;
  error?: string;
  stopReason?: "stop" | "aborted" | "max_turns";
}

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
) => Promise<SubagentResult>;

const sanitizeId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const cleanDisplayName = (s: string) => s
  .replace(/[\p{Cc}\p{Cf}]/gu, " ");
const hasVisibleDisplayName = (s: string) => cleanDisplayName(s).trim().length > 0;
const shortId = () => randomBytes(4).toString("hex");

const TASK = z.object({
  display_name: z.string().refine(hasVisibleDisplayName, "display_name must contain visible characters"),
  subagent_type: z.string(),
  prompt: z.string(),
  resume: z.string().optional(),
});

type Task = z.infer<typeof TASK>;

interface Child {
  task: Task;
  definition: AgentDefinition | null;
  displayName: string;
  agentId: string;
  eventId: string;
  resultEmitted: boolean;
}

interface ChildOutcome {
  child: Child;
  result: SubagentResult;
}

const childContent = (result: SubagentResult) => result.status === "completed"
  ? result.text!
  : `Error: ${result.error ?? "Subagent failed"}`;

const failed = (error: string, stopReason?: SubagentResult["stopReason"]): SubagentResult => ({
  status: "failed",
  error,
  stopReason,
});

const cancelled = (error = "Subagent cancelled"): SubagentResult => ({ status: "cancelled", error, stopReason: "aborted" });

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const isAbortError = (error: unknown) => error instanceof AbortError;

function normalizeResult(result: SubagentResult): SubagentResult {
  if (result.stopReason === "aborted") return cancelled(result.error ?? "Subagent aborted");
  if (result.status === "cancelled") return cancelled(result.error);
  if (result.status === "failed") return failed(result.error ?? "Subagent failed", result.stopReason);
  if (result.stopReason !== "stop") {
    return failed(
      result.stopReason === "max_turns" ? "Subagent reached max turns" : "Subagent stopped without a terminal stop reason",
      result.stopReason,
    );
  }
  if (!result.text?.trim()) return failed("Subagent stopped without a final answer", "stop");
  return { status: "completed", text: result.text, stopReason: "stop" };
}

function groupStatus(results: SubagentResult[]): BackgroundRunResult["status"] {
  if (results.every((result) => result.status === "completed")) return "completed";
  if (results.every((result) => result.status === "failed")) return "failed";
  if (results.every((result) => result.status === "cancelled")) return "cancelled";
  return "partial";
}

export function agentTool(opts: { loader: AgentLoader; spawn: Spawn; pool?: SubagentPool }): Tool {
  const { loader, spawn } = opts;
  // Task 4 supplies one root-owned pool. This fallback keeps a directly created tool
  // usable while retaining the same non-blocking session-owned background contract.
  const pool = opts.pool ?? createSubagentPool(5);

  return defineTool({
    name: "Agent",
    description:
      "Delegate a large or context-heavy subtask to a specialized subagent, keeping your own context clean. Each entry in tasks is accepted as an asynchronous group member and the complete group result arrives together later in this session. " +
      "Give every task a distinct display_name for user-visible progress. To run subtasks in parallel, pass them as MULTIPLE entries in a SINGLE call — do not issue separate Agent calls for that. " +
      "To continue a previous subagent, pass its reported agentId as resume.",
    schema: z.object({
      tasks: z.array(TASK).min(1),
      // Accepted for one release so old callers parse, but Agent groups are always backgrounded.
      run_in_background: z.boolean().optional(),
    }),
    security: { network: "loopback", filesystem: "workspace", sideEffects: "workspace" },
    execute: async ({ tasks }, ctx) => {
      if (tasks.some((task) => !hasVisibleDisplayName(task.display_name))) {
        throw new Error("display_name must contain visible characters");
      }
      if (!ctx.background) throw new Error("Agent requires background tasks; enable background to dispatch subagents.");

      const runBatch = async (
        signal: AbortSignal,
        emit: (e: AgentEvent) => void,
      ): Promise<BackgroundRunResult> => {
        const children = tasks.map((task): Child => {
          const definition = loader.get(task.subagent_type);
          const displayName = cleanDisplayName(task.display_name);
          const eventId = definition
            ? (task.resume ? sanitizeId(task.resume) : `agent-${sanitizeId(task.subagent_type) || "unknown"}-${shortId()}`)
            : `agent-${sanitizeId(task.subagent_type) || "unknown"}-${shortId()}`;
          const child: Child = {
            task,
            definition,
            displayName,
            agentId: definition ? eventId : "-",
            eventId,
            resultEmitted: false,
          };
          emit({
            type: "tool_use",
            call: {
              id: child.eventId,
              name: child.displayName,
              input: {
                display_name: task.display_name,
                subagent_type: task.subagent_type,
                prompt: task.prompt,
              },
            },
          });
          return child;
        });

        const emitResult = (child: Child, result: SubagentResult) => {
          if (child.resultEmitted) return;
          child.resultEmitted = true;
          emit({
            type: "tool_result",
            result: {
              id: child.eventId,
              name: child.displayName,
              content: childContent(result),
              isError: result.status !== "completed",
            },
          });
        };

        const runChild = async (child: Child, childSignal: AbortSignal): Promise<ChildOutcome> => {
          if (!child.definition) {
            const result = failed(
              `unknown subagent_type '${cleanDisplayName(child.task.subagent_type)}'. Available: ${
                loader.names().join(", ") || "(none)"
              }`,
            );
            emitResult(child, result);
            return { child, result };
          }
          try {
            const result = normalizeResult(await spawn(child.definition, child.task.prompt, {
              signal: childSignal,
              sessionId: child.eventId,
              onEvent: (event) => emit({ ...event, agentId: child.eventId }),
            }));
            emitResult(child, result);
            return { child, result };
          } catch (error) {
            const result = childSignal.aborted || isAbortError(error)
              ? cancelled(errorMessage(error))
              : failed(errorMessage(error));
            emitResult(child, result);
            return { child, result };
          }
        };

        const settled = await Promise.allSettled(
          children.map((child) =>
            pool.run((childSignal) => runChild(child, childSignal), signal, ctx.sessionId),
          ),
        );
        const outcomes = settled.map((entry, index): ChildOutcome => {
          if (entry.status === "fulfilled") return entry.value;
          const child = children[index]!;
          const result = signal.aborted || isAbortError(entry.reason)
            ? cancelled(errorMessage(entry.reason))
            : failed(errorMessage(entry.reason));
          emitResult(child, result);
          return { child, result };
        });
        const results = outcomes.map((outcome) => outcome.result);
        return {
          status: groupStatus(results),
          content: outcomes
            .map(({ child, result }) =>
              `## ${child.displayName} (agentId: ${child.agentId}; status: ${result.status})\n${childContent(result)}`)
            .join("\n\n"),
        };
      };

      const handle = ctx.background.spawn({
        label: `Subagent group: ${tasks.map((task) => cleanDisplayName(task.display_name)).join(", ")}`,
        kind: "detached",
        run: (signal, emit) => runBatch(signal, emit),
      });
      const noun = tasks.length === 1 ? "subagent" : "subagents";
      return `[background:${handle.id}] accepted group with ${tasks.length} ${noun}; results will arrive together.`;
    },
  });
}
