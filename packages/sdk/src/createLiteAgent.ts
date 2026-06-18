import { createAgent, nativeCodec } from "@lite-agent/core";
import type { Agent, Middleware, ModelProvider, Tool } from "@lite-agent/core";
import { defaultTools } from "./tools";
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
  if (cfg.allowedTools) tools = tools.filter((t) => cfg.allowedTools!.includes(t.name));
  if (cfg.disallowedTools) tools = tools.filter((t) => !cfg.disallowedTools!.includes(t.name));

  const system = cfg.system ?? buildSystemPrompt({ workdir: cfg.workdir, modelName: cfg.modelName, skills });

  return createAgent({
    model: cfg.model,
    modelName: cfg.modelName,
    codec: nativeCodec(),
    tools,
    use: cfg.use,
    system,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
  });
}
