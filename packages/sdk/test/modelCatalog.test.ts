import { expect, test } from "vitest";
import type { ModelProvider } from "@lite-agent/core";
import { createModelResolver } from "../src/modelCatalog";

const provider = (id: string): ModelProvider => ({
  id,
  async *stream() {},
});

const catalog = () => ({
  models: {
    simple: { provider: provider("simple-provider"), modelName: "fast-id", displayName: "Fast" },
    medium: { provider: provider("medium-provider"), modelName: "balanced-id", displayName: "Balanced" },
    complex: { provider: provider("complex-provider"), modelName: "strong-id", displayName: "Strong" },
  },
  defaultModel: "medium" as const,
});

test("resolves the configured default tier and each tier alias", () => {
  const resolver = createModelResolver(catalog());
  expect(resolver.defaultModel).toMatchObject({ tier: "medium", modelName: "balanced-id", displayName: "Balanced" });
  expect(resolver.resolve("simple")).toMatchObject({ tier: "simple", modelName: "fast-id" });
  expect(resolver.resolve("complex")).toMatchObject({ tier: "complex", modelName: "strong-id" });
});

test("inherits the current model when selection is omitted and preserves raw ids", () => {
  const resolver = createModelResolver(catalog());
  const inherited = resolver.resolve("complex");
  expect(resolver.resolve(undefined, inherited)).toBe(inherited);
  expect(resolver.resolve("raw-provider-id", inherited)).toMatchObject({
    provider: inherited.provider,
    modelName: "raw-provider-id",
    tier: undefined,
    displayName: "raw-provider-id",
  });
});

test("legacy single-model config resolves one provider and model id", () => {
  const legacy = provider("legacy-provider");
  const resolver = createModelResolver({ model: legacy, modelName: "legacy-id" });
  expect(resolver.defaultModel).toMatchObject({ provider: legacy, modelName: "legacy-id", displayName: "legacy-id" });
});

test("rejects incomplete catalogs, invalid defaults, and empty model ids", () => {
  expect(() => createModelResolver({ models: { simple: catalog().models.simple } as never, defaultModel: "simple" })).toThrow(/simple.*medium.*complex|profiles/i);
  expect(() => createModelResolver({ ...catalog(), defaultModel: "unknown" as never })).toThrow(/defaultModel/i);
  expect(() => createModelResolver({ ...catalog(), models: { ...catalog().models, simple: { provider: provider("p"), modelName: "" } } })).toThrow(/modelName/i);
});

test("rejects mixed tiered and legacy configuration instead of choosing silently", () => {
  expect(() => createModelResolver({ ...catalog(), model: provider("legacy-provider") })).toThrow(/conflict|either|二选一/i);
  expect(() => createModelResolver({ ...catalog(), modelName: "legacy-id" })).toThrow(/conflict|either|二选一/i);
  expect(() => createModelResolver({ model: provider("legacy-provider"), modelName: "legacy-id", defaultModel: "medium" })).toThrow(/conflict|either|二选一/i);
});

test("rejects malformed providers and blank raw selections", () => {
  const malformed = (value: unknown) => ({ provider: value, modelName: "id" });
  expect(() => createModelResolver({ ...catalog(), models: { ...catalog().models, simple: malformed({ id: "", stream: async function* () {} }) } as never })).toThrow(/provider.*id/i);
  expect(() => createModelResolver({ ...catalog(), models: { ...catalog().models, simple: malformed({ id: "provider", stream: undefined }) } as never })).toThrow(/provider.*stream/i);
  expect(() => createModelResolver({ model: malformed({ id: "", stream: async function* () {} }) as never, modelName: "id" })).toThrow(/provider.*id/i);

  const resolver = createModelResolver(catalog());
  expect(() => resolver.resolve("")).toThrow(/selection|modelName/i);
  expect(() => resolver.resolve("   ")).toThrow(/selection|modelName/i);
});
