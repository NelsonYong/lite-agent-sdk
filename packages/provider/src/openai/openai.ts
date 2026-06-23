import OpenAI from "openai";
import type { ModelChunk, ModelProvider, ModelRequest } from "@lite-agent/core";
import { ProviderError } from "@lite-agent/core";
import { toOpenAIParams } from "./mapping";
import { translateStream } from "./stream";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

export interface OpenAIClientLike {
  chat: {
    completions: {
      create(
        params: Params,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<Chunk>> | AsyncIterable<Chunk>;
    };
  };
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  client?: OpenAIClientLike;
}

function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const status =
    typeof (e as { status?: unknown }).status === "number"
      ? (e as { status: number }).status
      : undefined;
  const message = e instanceof Error ? e.message : String(e);
  return new ProviderError(message, status);
}

export function openai(opts: OpenAIProviderOptions = {}): ModelProvider {
  const client: OpenAIClientLike =
    opts.client ??
    (new OpenAI({
      apiKey: opts.apiKey ?? process.env["OPENAI_API_KEY"],
      baseURL: opts.baseURL ?? process.env["OPENAI_BASE_URL"],
    }) as unknown as OpenAIClientLike);

  return {
    id: "openai",
    async *stream(
      req: ModelRequest,
      signal?: AbortSignal,
    ): AsyncIterable<ModelChunk> {
      const params = toOpenAIParams(req);
      try {
        const raw = await client.chat.completions.create(
          params,
          signal ? { signal } : undefined,
        );
        yield* translateStream(raw);
      } catch (e) {
        throw toProviderError(e);
      }
    },
  };
}
