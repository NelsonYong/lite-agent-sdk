import { AgentError } from "@lite-agent/core";
import type { ModelProvider, ReasoningEffort } from "@lite-agent/core";

export const MODEL_TIERS = ["simple", "medium", "complex"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type ModelProfile = {
  provider: ModelProvider;
  modelName: string;
  displayName?: string;
  reasoningEffort?: ReasoningEffort;
};

export type ModelProfiles = Partial<Record<ModelTier, ModelProfile>>;

export type ModelCatalog = {
  models: ModelProfiles;
  defaultModel: ModelTier;
};

export type ModelConfiguration = {
  model?: ModelProvider;
  modelName?: string;
  models?: ModelProfiles;
  defaultModel?: ModelTier;
};

export type ResolvedModel = {
  provider: ModelProvider;
  modelName: string;
  displayName: string;
  tier?: ModelTier;
  reasoningEffort?: ReasoningEffort;
};

export type ModelResolver = {
  readonly defaultModel: ResolvedModel;
  resolve(selection?: string, inherited?: ResolvedModel): ResolvedModel;
};

const isModelTier = (value: string): value is ModelTier =>
  (MODEL_TIERS as readonly string[]).includes(value);

const profileToResolved = (profile: ModelProfile, tier?: ModelTier): ResolvedModel => ({
  provider: profile.provider,
  modelName: profile.modelName,
  displayName: profile.displayName ?? profile.modelName,
  tier,
  ...(profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort }),
});

const assertProvider: (provider: unknown, name: string) => asserts provider is ModelProvider = (provider, name) => {
  if (!provider || typeof provider !== "object") {
    throw new AgentError(`${name} provider is required`);
  }
  const candidate = provider as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    throw new AgentError(`${name} provider id must be non-empty`);
  }
  if (typeof candidate.stream !== "function") {
    throw new AgentError(`${name} provider stream must be a function`);
  }
};

const assertProfile: (profile: unknown, name: string) => asserts profile is ModelProfile = (profile, name) => {
  if (!profile || typeof profile !== "object" || !("provider" in profile) || !profile.provider) {
    throw new AgentError(`models.${name} requires a provider`);
  }
  assertProvider(profile.provider, `models.${name}`);
  if ("reasoningEffort" in profile && profile.reasoningEffort !== undefined && !["low", "medium", "high"].includes(String(profile.reasoningEffort)))
    throw new AgentError(`models.${name}.reasoningEffort must be low, medium, or high`);
  if (!("modelName" in profile) || typeof profile.modelName !== "string" || !profile.modelName.trim()) {
    throw new AgentError(`models.${name}.modelName must be non-empty`);
  }
};

const assertTierKeys: (models: unknown) => asserts models is ModelProfiles = (models) => {
  if (!models || typeof models !== "object") throw new AgentError("models requires at least one simple, medium, or complex profile");
  const candidate = models as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length === 0 || keys.some((key) => !isModelTier(key))) {
    throw new AgentError("models accepts only simple, medium, and complex profiles");
  }
  for (const tier of keys) assertProfile(candidate[tier], tier);
};

export function createModelResolver(config: ModelConfiguration): ModelResolver {
  if (config.models !== undefined) {
    if (config.model !== undefined || config.modelName !== undefined) {
      throw new AgentError("model/models configuration conflict; choose either tiered models or legacy model/modelName");
    }
    assertTierKeys(config.models);
    if (!config.defaultModel || !isModelTier(config.defaultModel) || !config.models[config.defaultModel]) {
      throw new AgentError("defaultModel must name a configured simple, medium, or complex profile");
    }

    const profiles = Object.fromEntries(
      Object.entries(config.models).map(([tier, profile]) => [tier, profileToResolved(profile, tier as ModelTier)]),
    ) as Partial<Record<ModelTier, ResolvedModel>>;
    const defaultModel = profiles[config.defaultModel]!;

    return {
      defaultModel,
      resolve(selection, inherited) {
        if (selection === undefined) return inherited ?? defaultModel;
        if (typeof selection !== "string" || !selection.trim()) {
          throw new AgentError("model selection must be non-empty");
        }
        if (isModelTier(selection)) {
          const profile = profiles[selection];
          if (!profile) throw new AgentError(`model profile ${selection} is not configured`);
          return profile;
        }
        throw new AgentError(`model profile ${selection} is not configured`);
      },
    };
  }

  if (config.defaultModel !== undefined) {
    throw new AgentError("defaultModel requires models; choose either tiered models/defaultModel or legacy model/modelName");
  }
  if (!config.model) throw new AgentError("model is required when models is not configured");
  assertProvider(config.model, "model");
  if (typeof config.modelName !== "string" || !config.modelName.trim()) {
    throw new AgentError("modelName must be non-empty when models is not configured");
  }
  const defaultModel = profileToResolved({ provider: config.model, modelName: config.modelName });

  return {
    defaultModel,
    resolve(selection, inherited) {
      if (selection === undefined) return inherited ?? defaultModel;
      if (typeof selection !== "string" || !selection.trim()) {
        throw new AgentError("model selection must be non-empty");
      }
      const base = inherited ?? defaultModel;
      return { provider: base.provider, modelName: selection, displayName: selection, tier: undefined };
    },
  };
}
