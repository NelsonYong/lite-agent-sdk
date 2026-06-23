import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";
import type { SkillLoader } from "./loader";

export function loadSkillTool(loader: SkillLoader): Tool {
  return defineTool({
    name: "load_skill",
    description:
      "Load a skill's full instructions by name before tackling an unfamiliar task.",
    schema: z.object({ name: z.string() }),
    execute: ({ name }) => loader.getContent(name),
  });
}
