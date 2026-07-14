import { test } from "vitest";
import {
  providerConformance,
  type ProviderConformanceFactory,
} from "@lite-agent/core";
import { anthropicConformance } from "./support/anthropicConformance";
import { openaiConformance } from "./support/openaiConformance";

const providers: Array<{
  name: string;
  make: ProviderConformanceFactory;
}> = [
  { name: "openai", make: openaiConformance },
  { name: "anthropic", make: anthropicConformance },
];

for (const provider of providers) {
  for (const contract of providerConformance) {
    test(`${provider.name} provider: ${contract.name}`, async () => {
      await contract.run(provider.make);
    });
  }
}
