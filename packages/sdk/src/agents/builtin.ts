import type { AgentDefinition } from "./types";

/**
 * Always-available subagent so the `Agent` capability works out of the box with
 * no `agents/*.md` files. A user definition named `general-purpose` overrides it.
 * `tools`/`model` are omitted → it inherits the parent's full tool set and model.
 */
export const GENERAL_PURPOSE: AgentDefinition = {
  name: "general-purpose",
  description:
    "General-purpose subagent for researching complex questions, searching code, and executing multi-step tasks autonomously. Delegate large or context-heavy subtasks here to keep your own context clean.",
  body:
    "You are a general-purpose subagent. Complete the assigned task autonomously and thoroughly using the tools available to you, then return a concise, self-contained final answer as your last message. You cannot ask follow-up questions, so make reasonable assumptions and state them.",
  path: "<builtin>",
};

/** The built-in subagent definitions seeded into every AgentLoader (unless overridden). */
export function builtinAgents(): AgentDefinition[] {
  return [GENERAL_PURPOSE];
}
