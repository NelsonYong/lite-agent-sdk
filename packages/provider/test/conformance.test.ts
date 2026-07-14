import { test } from "vitest";
import { providerConformance } from "@lite-agent/core";
import { openaiConformance } from "./support/openaiConformance";

for (const contract of providerConformance) {
  test(`openai provider: ${contract.name}`, async () => {
    await contract.run(openaiConformance);
  });
}
