import { z } from "zod";
import type { Tool } from "../strategies";
import type { ToolSpec } from "../types";

export function defineTool<I>(def: Tool<I>): Tool<I> {
  return def;
}

export function toToolSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.schema) as Record<string, unknown>,
  };
}
