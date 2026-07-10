import type { ZodType } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, ToolContext, ToolSecurity } from "@lite-agent/core";

export function tool<I>(
  name: string,
  description: string,
  schema: ZodType<I>,
  handler: (input: I, ctx: ToolContext) => Promise<string> | string,
  opts: { security?: ToolSecurity } = {},
): Tool<I> {
  return defineTool({ name, description, schema, security: opts.security, execute: handler });
}
