import { test } from "vitest";
import { ProviderError } from "../src/events";
import type { ModelProvider } from "../src/strategies";
import type { ContentBlock } from "../src/types";
import {
  providerConformance,
  type ProviderConformanceFactory,
  type ProviderConformanceScenario,
} from "../src/testing/providerConformance";

function providerError(error: unknown): ProviderError {
  const status = typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
  return new ProviderError(error instanceof Error ? error.message : String(error), status);
}

const scriptedProvider: ProviderConformanceFactory = (
  scenario: ProviderConformanceScenario,
): ModelProvider => ({
  id: "scripted",
  async *stream(_req, signal) {
    if (scenario.kind === "abort") {
      if (!signal) {
        await new Promise<never>(() => {});
        return;
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return;
    }

    if (scenario.kind === "error") {
      if (scenario.afterText) {
        yield { type: "text_delta", text: scenario.afterText };
      }
      throw providerError(scenario.error);
    }

    for (const text of scenario.kind === "text"
      ? scenario.deltas
      : scenario.textDeltas) {
      yield { type: "text_delta", text };
    }

    const content: ContentBlock[] = [];
    const text = (scenario.kind === "text"
      ? scenario.deltas
      : scenario.textDeltas).join("");
    if (text) content.push({ type: "text", text });
    if (scenario.kind === "tool") {
      content.push({ type: "tool_call", ...scenario.call });
    }

    yield {
      type: "message_done",
      message: { role: "assistant", content },
      usage: scenario.usage,
    };
  },
});

for (const contract of providerConformance) {
  test(`provider conformance self-test: ${contract.name}`, async () => {
    await contract.run(scriptedProvider);
  });
}
