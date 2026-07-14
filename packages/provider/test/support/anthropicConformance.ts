import type Anthropic from "@anthropic-ai/sdk";
import type {
  ProviderConformanceFactory,
  ProviderConformanceScenario,
} from "@lite-agent/core";
import { anthropic } from "../../src/anthropic";
import type { AnthropicClientLike } from "../../src/anthropic";

type Event = Anthropic.RawMessageStreamEvent;

const event = (value: unknown): Event => value as Event;

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
): AsyncIterable<Event> {
  if (scenario.kind === "abort") {
    await waitForAbort(signal);
    throw new Error("aborted");
  }

  if (scenario.kind === "error") {
    if (scenario.afterText) {
      yield event({
        type: "message_start",
        message: { usage: { input_tokens: 1, output_tokens: 0 } },
      });
      yield event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      yield event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: scenario.afterText },
      });
    }
    throw scenario.error;
  }

  yield event({
    type: "message_start",
    message: {
      usage: { input_tokens: scenario.usage.inputTokens, output_tokens: 0 },
    },
  });

  const deltas = scenario.kind === "text"
    ? scenario.deltas
    : scenario.textDeltas;
  let index = 0;
  if (deltas.length > 0) {
    yield event({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    for (const text of deltas) {
      yield event({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
      });
    }
    yield event({ type: "content_block_stop", index });
    index += 1;
  }

  if (scenario.kind === "tool") {
    yield event({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: scenario.call.id,
        name: scenario.call.name,
        input: {},
      },
    });
    yield event({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(scenario.call.input),
      },
    });
    yield event({ type: "content_block_stop", index });
  }

  yield event({
    type: "message_delta",
    delta: {},
    usage: { output_tokens: scenario.usage.outputTokens },
  });
  yield event({ type: "message_stop" });
}

export const anthropicConformance: ProviderConformanceFactory = (scenario) => {
  const client: AnthropicClientLike = {
    messages: {
      create(_params, options) {
        return events(scenario, options?.signal);
      },
    },
  };
  return anthropic({ client });
};
