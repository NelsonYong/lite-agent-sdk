import Anthropic from "@anthropic-ai/sdk";
import type { ModelChunk, ModelProvider, ModelRequest, ProviderContextEdit } from "@lite-agent/core";
import { ProviderError } from "@lite-agent/core";
import { toAnthropicParams } from "./mapping";
import { translateStream } from "./stream";

// Minimal structural shape we depend on — lets tests inject a fake (no network).
export interface AnthropicClientLike {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ):
      | Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>>
      | AsyncIterable<Anthropic.RawMessageStreamEvent>;
    countTokens?(
      params: Anthropic.MessageCountTokensParams,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.MessageTokensCount> | Anthropic.MessageTokensCount;
  };
  /** Optional beta surface used only for Anthropic-native context management. */
  beta?: {
    messages?: {
      create(
        params: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
    };
  };
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  client?: AnthropicClientLike;
  /**
   * The Anthropic SDK's own internal retry count. Defaults to 0 so retry policy is
   * owned by the `retry()` middleware (otherwise the two compound). Set this to
   * restore SDK-level retries.
   */
  maxRetries?: number;
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

export function anthropic(opts: AnthropicProviderOptions = {}): ModelProvider {
  const client: AnthropicClientLike =
    opts.client ??
    (new Anthropic({
      apiKey: opts.apiKey ?? process.env["ANTHROPIC_API_KEY"],
      baseURL: opts.baseURL ?? process.env["BASE_URL"],
      maxRetries: opts.maxRetries ?? 0,
    }) as unknown as AnthropicClientLike);

  const countTokens = client.messages?.countTokens?.bind(client.messages);
  const betaCreate = client.beta?.messages?.create?.bind(client.beta.messages);
  type NativeEdit =
    | { type: "clear_tool_uses_20250919" }
    | { type: "clear_thinking_20251015" }
    | { type: "compact_20260112" };
  const nativeEdits = new WeakMap<ModelRequest, NativeEdit[]>();
  const addNativeEdit = (req: ModelRequest, edit: NativeEdit): ModelRequest => {
    const edits = nativeEdits.get(req) ?? [];
    if (!edits.some((candidate) => candidate.type === edit.type)) edits.push(edit);
    nativeEdits.set(req, edits);
    return req;
  };
  const nativeEdit = (edit: NativeEdit): ProviderContextEdit => (req) => addNativeEdit(req, edit);
  const context: NonNullable<ModelProvider["context"]> = {
    promptCache: { mode: "automatic" },
    ...(betaCreate && {
      clearToolUses: nativeEdit({ type: "clear_tool_uses_20250919" }),
      clearThinking: nativeEdit({ type: "clear_thinking_20251015" }),
      compact: nativeEdit({ type: "compact_20260112" }),
    }),
    ...(countTokens && { countTokens: async (req, signal) => {
      const { stream: _stream, max_tokens: _maxTokens, ...params } =
        toAnthropicParams(req, { promptCache: true });
      try {
        const result = await countTokens(
          params as Anthropic.MessageCountTokensParams,
          signal ? { signal } : undefined,
        );
        return result.input_tokens;
      } catch (e) {
        throw toProviderError(e);
      }
    } }),
  };

  return {
    id: "anthropic",
    context,
    async *stream(
      req: ModelRequest,
      signal?: AbortSignal,
    ): AsyncIterable<ModelChunk> {
      const params = toAnthropicParams(req, { promptCache: true });
      const edits = nativeEdits.get(req);
      if (edits?.length) {
        const betaParams = params as unknown as {
          betas?: string[];
          context_management?: { edits: NativeEdit[] };
        };
        betaParams.betas = ["context-management-2025-06-27"];
        betaParams.context_management = { edits };
      }
      try {
        const raw = edits?.length && betaCreate
          ? await betaCreate(params, signal ? { signal } : undefined)
          : await client.messages.create(params, signal ? { signal } : undefined);
        yield* translateStream(raw as AsyncIterable<Anthropic.RawMessageStreamEvent>);
      } catch (e) {
        throw toProviderError(e);
      }
    },
  };
}
