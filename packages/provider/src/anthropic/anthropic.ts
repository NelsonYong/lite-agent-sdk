import Anthropic from "@anthropic-ai/sdk";
import type { ModelChunk, ModelProvider, ModelRequest } from "@lite-agent-sdk/core";
import { ProviderError } from "@lite-agent-sdk/core";
import { toAnthropicParams } from "./mapping";
import { translateStream } from "./stream";

// Minimal structural shape we depend on — lets tests inject a fake (no network).
export interface AnthropicClientLike {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>> | AsyncIterable<Anthropic.RawMessageStreamEvent>;
  };
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  client?: AnthropicClientLike;
}

function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const status = typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : undefined;
  const message = e instanceof Error ? e.message : String(e);
  return new ProviderError(message, status);
}

export function anthropic(opts: AnthropicProviderOptions = {}): ModelProvider {
  const client: AnthropicClientLike =
    opts.client ??
    (new Anthropic({
      apiKey: opts.apiKey ?? process.env["ANTHROPIC_API_KEY"],
      baseURL: opts.baseURL ?? process.env["BASE_URL"],
    }) as unknown as AnthropicClientLike);

  return {
    id: "anthropic",
    async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk> {
      const params = toAnthropicParams(req);
      try {
        const raw = await client.messages.create(params, signal ? { signal } : undefined);
        yield* translateStream(raw);
      } catch (e) {
        throw toProviderError(e);
      }
    },
  };
}
