import type { Tool } from "@lite-agent/core";
import { bashTool } from "./bash";
import { fileTools } from "./file";
import type { BashToolOptions } from "./bash";
import type { FileToolsOptions } from "./file";

export function defaultTools(
  workdir: string,
  opts: { bash?: BashToolOptions; files?: FileToolsOptions } = {},
): Tool[] {
  return [bashTool(workdir, opts.bash), ...fileTools(workdir, opts.files)];
}

export { bashTool } from "./bash";
export type { BashToolOptions } from "./bash";
export { fileTools, makeSafePath, resolveSafePath, atomicWriteFile } from "./file";
export type { FileToolsOptions } from "./file";
export { askUserTool } from "./askUser";
export { taskTools } from "./task";
export { agentTool } from "./agent";
export { killBackgroundTool } from "./killBackground";
export { bashOutputTool } from "./bashOutput";
