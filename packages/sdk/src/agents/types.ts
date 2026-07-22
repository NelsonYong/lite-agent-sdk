export interface AgentDefinition {
  /** From frontmatter `name`, else the filename (sans `.md`). */
  name: string;
  /** When to use this subagent — surfaced to the main agent. */
  description: string;
  /** Allow-list of tool names; absent = inherit the parent's tool set. */
  tools?: string[];
  /** Model selection; tier aliases may choose another configured provider. */
  model?: string;
  /** The subagent's system prompt. */
  body: string;
  /** Source file path (diagnostics). */
  path: string;
}
