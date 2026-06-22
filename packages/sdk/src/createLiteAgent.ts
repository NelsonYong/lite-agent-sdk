import { createAgent, nativeCodec, permission } from "@lite-agent-sdk/core";
import type { Agent, ApprovalHandler, InputHandler, Middleware, ModelProvider, PermissionPolicy, Sandbox, Tool } from "@lite-agent-sdk/core";
import { defaultTools, askUserTool } from "./tools";
import { SkillLoader } from "./skills/loader";
import { loadSkillTool } from "./skills/loadSkillTool";
import { buildSystemPrompt } from "./system";

export interface CreateLiteAgentConfig {
  model: ModelProvider;
  modelName?: string;
  workdir: string;
  skillsDir?: string;
  tools?: Tool[];
  system?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  use?: Middleware[];
  sandbox?: Sandbox;
  permission?: PermissionPolicy;
  onApproval?: ApprovalHandler;
  onAskUser?: InputHandler;
}

export function createLiteAgent(cfg: CreateLiteAgentConfig): Agent {
  let tools: Tool[] = [...defaultTools(cfg.workdir)];
  let skills = "(no skills available)";

  if (cfg.skillsDir) {
    const loader = new SkillLoader(cfg.skillsDir);
    tools.push(loadSkillTool(loader));
    skills = loader.getDescriptions();
  }
  if (cfg.tools) tools.push(...cfg.tools);
  if (cfg.onAskUser) tools.push(askUserTool());
  if (cfg.allowedTools) tools = tools.filter((t) => cfg.allowedTools!.includes(t.name));
  if (cfg.disallowedTools) tools = tools.filter((t) => !cfg.disallowedTools!.includes(t.name));

  const system = cfg.system ?? buildSystemPrompt({ workdir: cfg.workdir, modelName: cfg.modelName, skills });

  const use: Middleware[] = [
    ...(cfg.permission ? [permission(cfg.permission, cfg.onApproval)] : []),
    ...(cfg.use ?? []),
  ];

  return createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec: nativeCodec(),
    tools,
    use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    sandbox: cfg.sandbox,
    input: cfg.onAskUser,
  });
}
