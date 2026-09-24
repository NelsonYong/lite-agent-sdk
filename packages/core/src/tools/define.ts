import type { ZodType } from "zod";
import type { Tool } from "../strategies";
import type { ToolSpec } from "../types";

export function defineTool<I>(def: Tool<I> & { schema: ZodType<I> }): Tool<I> & { schema: ZodType<I> };
export function defineTool<I>(def: Tool<I>): Tool<I>;
export function defineTool<I>(def: Tool<I>): Tool<I> {
  return def;
}

export function toToolSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
  };
}
