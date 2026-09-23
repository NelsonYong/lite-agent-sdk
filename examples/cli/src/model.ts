import { anthropic, openai } from "@lite-agent/provider";
import type { ModelConfiguration, ModelProvider, ModelProfiles, ReasoningEffort } from "@lite-agent/sdk";

export type Protocol = "anthropic" | "openai";

// Explicit LITE_AGENT_MODEL_PROTOCOL wins; otherwise infer from the model id.
export function detectProtocol(modelId: string, override?: string): Protocol {
  if (override === "anthropic" || override === "openai") return override;
  const id = modelId.toLowerCase();
  return id.startsWith("claude") || id.startsWith("anthropic")
    ? "anthropic"
    : "openai";
}

export interface ResolvedModel {
  provider: ModelProvider;
  modelName: string;
  protocol: Protocol;
}

// Build a provider from the LITE_AGENT_* env vars, picking the protocol automatically.
export function resolveModel(): ResolvedModel {
  const modelName = process.env["LITE_AGENT_MODEL_ID"];
  if (!modelName) {
    throw new Error(
      "LITE_AGENT_MODEL_ID is required (set it in examples/cli/.env)",
    );
  }
  const apiKey = process.env["LITE_AGENT_MODEL_API_KEY"];
  const baseURL = process.env["LITE_AGENT_BASE_URL"];
  const protocol = detectProtocol(
    modelName,
    process.env["LITE_AGENT_MODEL_PROTOCOL"],
  );
  const provider =
    protocol === "anthropic"
      ? anthropic({ apiKey, baseURL })
      : openai({ apiKey, baseURL });
  return { provider, modelName, protocol };
}

/** Optional tier overrides use the same endpoint and credentials as the base model. */
export function modelConfiguration(base: ResolvedModel): ModelConfiguration & { reasoningEffort?: ReasoningEffort } {
  const effort = (key: string): ReasoningEffort | undefined => {
    const value = process.env[key];
    if (!value) return undefined;
    if (value !== "low" && value !== "medium" && value !== "high")
      throw new Error(`${key} must be low, medium, or high`);
    return value;
  };
  const reasoningEffort = effort("LITE_AGENT_REASONING_EFFORT");
  const models: ModelProfiles = {
    medium: { provider: base.provider, modelName: base.modelName, reasoningEffort },
  };
  let tiered = false;
  for (const tier of ["simple", "medium", "complex"] as const) {
    const prefix = `LITE_AGENT_${tier.toUpperCase()}`;
    const modelName = process.env[`${prefix}_MODEL_ID`];
    const tierEffort = effort(`${prefix}_REASONING_EFFORT`);
    if (!modelName && !tierEffort) continue;
    tiered = true;
    models[tier] = { provider: base.provider, modelName: modelName ?? base.modelName, reasoningEffort: tierEffort ?? reasoningEffort };
  }
  return tiered ? { models, defaultModel: "medium" }
    : { model: base.provider, modelName: base.modelName, reasoningEffort };
}
