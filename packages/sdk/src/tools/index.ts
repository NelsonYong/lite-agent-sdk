import type { Tool } from "@lite-agent/core";
import { bashTool } from "./bash";
import { fileTools } from "./file";

export function defaultTools(workdir: string): Tool[] {
  return [bashTool(workdir), ...fileTools(workdir)];
}

export { bashTool } from "./bash";
export { fileTools, makeSafePath } from "./file";
export { askUserTool } from "./askUser";
export { taskTools } from "./task";
export { agentTool } from "./agent";
export { killBackgroundTool } from "./killBackground";
export { bashOutputTool } from "./bashOutput";
