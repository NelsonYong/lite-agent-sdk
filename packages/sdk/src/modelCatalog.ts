import { AgentError } from "@lite-agent/core";
import type { ModelProvider } from "@lite-agent/core";

export const MODEL_TIERS = ["simple", "medium", "complex"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type ModelProfile = {
  provider: ModelProvider;
  modelName: string;
  displayName?: string;
};

export type ModelProfiles = Record<ModelTier, ModelProfile>;

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
});

const assertProfile: (profile: unknown, name: string) => asserts profile is ModelProfile = (profile, name) => {
  if (!profile || typeof profile !== "object" || !("provider" in profile) || !profile.provider) {
    throw new AgentError(`models.${name} requires a provider`);
  }
  if (!("modelName" in profile) || typeof profile.modelName !== "string" || !profile.modelName.trim()) {
    throw new AgentError(`models.${name}.modelName must be non-empty`);
  }
};

const assertExactTierKeys: (models: unknown) => asserts models is ModelProfiles = (models) => {
  if (!models || typeof models !== "object") throw new AgentError("models requires simple, medium, and complex profiles");
  const candidate = models as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== MODEL_TIERS.length || !MODEL_TIERS.every((tier) => keys.includes(tier))) {
    throw new AgentError("models requires exactly simple, medium, and complex profiles");
  }
  for (const tier of MODEL_TIERS) assertProfile(candidate[tier], tier);
};

export function createModelResolver(config: ModelConfiguration): ModelResolver {
  if (config.models !== undefined) {
    assertExactTierKeys(config.models);
    if (!config.defaultModel || !isModelTier(config.defaultModel)) {
      throw new AgentError("defaultModel must be one of simple, medium, or complex");
    }

    const profiles = Object.fromEntries(
      MODEL_TIERS.map((tier) => [tier, profileToResolved(config.models![tier], tier)]),
    ) as Record<ModelTier, ResolvedModel>;
    const defaultModel = profiles[config.defaultModel];

    return {
      defaultModel,
      resolve(selection, inherited) {
        if (selection === undefined) return inherited ?? defaultModel;
        if (isModelTier(selection)) return profiles[selection];
        const base = inherited ?? defaultModel;
        return { provider: base.provider, modelName: selection, displayName: selection, tier: undefined };
      },
    };
  }

  if (!config.model) throw new AgentError("model is required when models is not configured");
  if (typeof config.modelName !== "string" || !config.modelName.trim()) {
    throw new AgentError("modelName must be non-empty when models is not configured");
  }
  const defaultModel = profileToResolved({ provider: config.model, modelName: config.modelName });

  return {
    defaultModel,
    resolve(selection, inherited) {
      if (selection === undefined) return inherited ?? defaultModel;
      const base = inherited ?? defaultModel;
      return { provider: base.provider, modelName: selection, displayName: selection, tier: undefined };
    },
  };
}
