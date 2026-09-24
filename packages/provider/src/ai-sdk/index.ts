import type { LanguageModelV4, LanguageModelV4CallOptions, SharedV4ProviderOptions, SharedV4Warning } from "@ai-sdk/provider";
import { abortable, ProviderError } from "@lite-agent/core";
import type { ModelProvider, ModelRequest, ProviderContextCapabilities } from "@lite-agent/core";
import { toAiPrompt } from "./mapping";
import { fromAiStream } from "./stream";

export interface AiSdkProviderOptions {
  /** Provider-native options; only the selected provider's adapter interprets these keys. */
  providerOptions?: SharedV4ProviderOptions | ((request: Readonly<ModelRequest>) => SharedV4ProviderOptions);
  /** Explicit host capabilities, e.g. a known context window. Never guessed from model names. */
  context?: ProviderContextCapabilities;
  onWarning?: (warning: SharedV4Warning) => void;
}

/** Bridge the current AI SDK provider contract without adding another agent loop, gateway or retry layer. */
export function aiSdk(model: LanguageModelV4, options: AiSdkProviderOptions = {}): ModelProvider {
  if (model.specificationVersion !== "v4" || typeof model.doStream !== "function") throw new Error("aiSdk requires an AI SDK 7 LanguageModelV4 provider");
  const nativeProvider = `ai-sdk:${model.provider}:${model.modelId}`;
  return {
    id: model.modelId,
    context: options.context,
    async *stream(req, outerSignal) {
      const controller = new AbortController();
      const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
      let reader: ReadableStreamDefaultReader<import("@ai-sdk/provider").LanguageModelV4StreamPart> | undefined;
      try {
        signal.throwIfAborted();
        if (req.model !== model.modelId) throw new ProviderError(`Bound AI SDK model is '${model.modelId}'; create a separate provider for model '${req.model}'`);
        const call: LanguageModelV4CallOptions = {
          prompt: toAiPrompt(req, nativeProvider), abortSignal: signal,
          maxOutputTokens: req.maxTokens, temperature: req.temperature, topP: req.topP,
          stopSequences: req.stopSequences, seed: req.seed, reasoning: req.reasoningEffort,
          providerOptions: typeof options.providerOptions === "function" ? options.providerOptions(req) : options.providerOptions,
        };
        if (req.tools?.length) {
          call.tools = req.tools.map(({ name, description, parameters }) => {
            const { $schema: _schema, ...inputSchema } = parameters;
            return { type: "function", name, description, inputSchema };
          });
          if (req.toolChoice) call.toolChoice = typeof req.toolChoice === "string" ? { type: req.toolChoice } : { type: "tool", toolName: req.toolChoice.tool };
        }
        const pending = Promise.resolve(model.doStream(call));
        // If a custom adapter resolves after cancellation, release its late stream too.
        void pending.then((result) => { if (signal.aborted) void result.stream.cancel().catch(() => {}); }, () => {});
        const result = await abortable(pending, signal);
        reader = result.stream.getReader();
        yield* fromAiStream(reader, nativeProvider, signal, options.onWarning);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        const candidate = error as { statusCode?: unknown; status?: unknown } | undefined;
        const status = candidate?.statusCode ?? candidate?.status;
        throw new ProviderError(error instanceof Error ? error.message : String(error), typeof status === "number" ? status : undefined);
      } finally {
        controller.abort();
        if (reader) {
          await abortable(reader.cancel(), signal).catch(() => {});
          reader.releaseLock();
        }
      }
    },
  };
}
