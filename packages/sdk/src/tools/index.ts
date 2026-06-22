import type { Tool } from "@lite-agent-sdk/core";
import { bashTool } from "./bash";
import { fileTools } from "./file";
import { todoTool } from "./todo";

export function defaultTools(workdir: string): Tool[] {
  return [bashTool(workdir), ...fileTools(workdir), todoTool()];
}

export { bashTool } from "./bash";
export { fileTools, makeSafePath } from "./file";
export { todoTool } from "./todo";
export { askUserTool } from "./askUser";
