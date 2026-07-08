import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

export function killBackgroundTool(): Tool {
  return defineTool({
    name: "KillBackground",
    description:
      "Cancel a running background task by its id (the bg_… id reported when it started). Use this to stop a background command or subagent batch that is hung or no longer needed.",
    schema: z.object({ id: z.string() }),
    execute: async ({ id }, ctx) => {
      if (!ctx.background) return "Background tasks are disabled.";
      return ctx.background.cancel(id)
        ? `Cancelled ${id}.`
        : `No running background task with id '${id}'.`;
    },
  });
}
