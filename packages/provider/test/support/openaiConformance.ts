import type OpenAI from "openai";
import type {
  ProviderConformanceFactory,
  ProviderConformanceScenario,
} from "@lite-agent/core";
import { openai } from "../../src/openai";
import type { OpenAIClientLike } from "../../src/openai";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

const chunk = (value: unknown): Chunk => value as Chunk;

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function* events(
  scenario: ProviderConformanceScenario,
  signal?: AbortSignal,
): AsyncIterable<Chunk> {
  if (scenario.kind === "abort") {
    await waitForAbort(signal);
    throw new Error("aborted");
  }

  if (scenario.kind === "error") {
    if (scenario.afterText) {
      yield chunk({ choices: [{ delta: { content: scenario.afterText } }] });
    }
    throw scenario.error;
  }

  const deltas = scenario.kind === "text"
    ? scenario.deltas
    : scenario.textDeltas;
  for (const text of deltas) {
    yield chunk({ choices: [{ delta: { content: text } }] });
  }

  if (scenario.kind === "tool") {
    yield chunk({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: scenario.call.id,
            function: {
              name: scenario.call.name,
              arguments: JSON.stringify(scenario.call.input),
            },
          }],
        },
      }],
    });
  }

  yield chunk({
    choices: [{ delta: {} }],
    usage: {
      prompt_tokens: scenario.usage.inputTokens,
      completion_tokens: scenario.usage.outputTokens,
    },
  });
}

export const openaiConformance: ProviderConformanceFactory = (scenario) => {
  const client: OpenAIClientLike = {
    chat: {
      completions: {
        create(_params, options) {
          return events(scenario, options?.signal);
        },
      },
    },
  };
  return openai({ client });
};
