import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

export function bashOutputTool(): Tool {
  return defineTool({
    name: "BashOutput",
    description:
      "Read new output from a background (detached) command started with bash run_in_background:true, by its bg_… id. Returns only output produced since your last read of that id. Optional `filter` is a regex; only matching lines are returned. When the process has exited, the result ends with [process exited].",
    schema: z.object({ id: z.string(), filter: z.string().optional() }),
    security: { network: "none", filesystem: "none", sideEffects: "none" },
    execute: async ({ id, filter }, ctx) => {
      if (!ctx.background) return "Background tasks are disabled.";
      const r = ctx.background.read(id, { filter: filter ? new RegExp(filter) : undefined });
      if (!r) return `No detached background task with id '${id}'.`;
      return (r.output || "(no new output)") + (r.done ? "\n[process exited]" : "");
    },
  });
}
