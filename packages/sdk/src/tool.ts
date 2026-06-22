import type { ZodType } from "zod";
import { defineTool } from "@lite-agent-sdk/core";
import type { Tool, ToolContext } from "@lite-agent-sdk/core";

export function tool<I>(
  name: string,
  description: string,
  schema: ZodType<I>,
  handler: (input: I, ctx: ToolContext) => Promise<string> | string,
): Tool<I> {
  return defineTool({ name, description, schema, execute: handler });
}
