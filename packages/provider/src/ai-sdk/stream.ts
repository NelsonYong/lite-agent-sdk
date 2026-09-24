import type { LanguageModelV4StreamPart, SharedV4ProviderMetadata, SharedV4Warning } from "@ai-sdk/provider";
import { abortable, ProviderError } from "@lite-agent/core";
import type { ContentBlock, ModelChunk, Usage } from "@lite-agent/core";
import type { NativeData } from "./mapping";

type Part = { block: ContentBlock; metadata?: SharedV4ProviderMetadata };
const merge = (previous: SharedV4ProviderMetadata | undefined, next: SharedV4ProviderMetadata | undefined): SharedV4ProviderMetadata | undefined => {
  if (!next) return previous;
  const result = { ...previous };
  for (const [key, value] of Object.entries(next)) result[key] = { ...result[key], ...value };
  return result;
};

export async function* fromAiStream(
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>,
  provider: string,
  signal: AbortSignal,
  onWarning?: (warning: SharedV4Warning) => void,
): AsyncGenerator<ModelChunk> {
  const parts: Part[] = [];
  const texts = new Map<string, Part>();
  const reasoning = new Map<string, Part>();
  const pendingTools = new Map<string, { name: string; input: string; metadata?: SharedV4ProviderMetadata }>();
  const completedTools = new Set<string>();
  let usage: Usage | undefined;
  let responseOptions: SharedV4ProviderMetadata | undefined;
  const native = (data: NativeData): ContentBlock => ({ type: "native", provider, data });
  for (;;) {
    signal.throwIfAborted();
    const { value: chunk, done } = await abortable(reader.read(), signal);
    if (done) break;
    if (usage) throw new ProviderError("AI SDK stream continued after its finish event");
    switch (chunk.type) {
      case "stream-start":
        for (const warning of chunk.warnings) {
          onWarning?.(warning);
          if (warning.type === "unsupported") throw new ProviderError(`AI SDK model does not support requested feature '${warning.feature}'`);
        }
        break;
      case "text-start": case "text-delta": case "text-end": {
        let part = texts.get(chunk.id);
        if (!part) { part = { block: { type: "text", text: "" } }; texts.set(chunk.id, part); parts.push(part); }
        part.metadata = merge(part.metadata, chunk.providerMetadata);
        if (chunk.type === "text-delta") {
          if (part.block.type === "text") part.block.text += chunk.delta;
          yield { type: "text_delta", text: chunk.delta };
        }
        break;
      }
      case "reasoning-start": case "reasoning-delta": case "reasoning-end": {
        let part = reasoning.get(chunk.id);
        if (!part) { part = { block: native({ kind: "reasoning", part: { type: "reasoning", text: "" } }) }; reasoning.set(chunk.id, part); parts.push(part); }
        part.metadata = merge(part.metadata, chunk.providerMetadata);
        const data = (part.block as Extract<ContentBlock, { type: "native" }>).data as Extract<NativeData, { kind: "reasoning" }>;
        if (chunk.type === "reasoning-delta") data.part.text += chunk.delta;
        if (part.metadata) data.part.providerOptions = part.metadata;
        break;
      }
      case "tool-input-start":
        if (chunk.providerExecuted) throw new ProviderError("Provider-executed tools are not enabled; use lite-agent tools and permissions");
        if (pendingTools.has(chunk.id) || completedTools.has(chunk.id)) throw new ProviderError("Duplicate tool call id");
        pendingTools.set(chunk.id, { name: chunk.toolName, input: "", metadata: chunk.providerMetadata });
        break;
      case "tool-input-delta": case "tool-input-end": {
        const pending = pendingTools.get(chunk.id);
        if (!pending) throw new ProviderError("Tool input arrived without a start event");
        if (chunk.type === "tool-input-delta") pending.input += chunk.delta;
        pending.metadata = merge(pending.metadata, chunk.providerMetadata);
        break;
      }
      case "tool-call": {
        if (chunk.providerExecuted) throw new ProviderError("Provider-executed tools are not enabled; use lite-agent tools and permissions");
        if (completedTools.has(chunk.toolCallId)) throw new ProviderError("Duplicate tool call id");
        const pending = pendingTools.get(chunk.toolCallId);
        if (pending && pending.name !== chunk.toolName) throw new ProviderError("Tool name changed during streaming");
        let input: unknown;
        try { input = JSON.parse(chunk.input); } catch { throw new ProviderError("Model returned malformed tool arguments"); }
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProviderError("Tool arguments must be a JSON object");
        parts.push({ block: { type: "tool_call", id: chunk.toolCallId, name: chunk.toolName, input }, metadata: merge(pending?.metadata, chunk.providerMetadata) });
        pendingTools.delete(chunk.toolCallId); completedTools.add(chunk.toolCallId);
        break;
      }
      case "custom": parts.push({ block: native({ kind: "custom", part: { type: "custom", kind: chunk.kind, providerOptions: chunk.providerMetadata } }) }); break;
      case "source": parts.push({ block: native({ kind: "source", source: chunk }) }); break;
      case "finish": {
        if (chunk.finishReason.unified === "error" || chunk.finishReason.unified === "content-filter") throw new ProviderError(`Model stopped with ${chunk.finishReason.unified}`);
        if (pendingTools.size) throw new ProviderError("Model ended with incomplete tool calls");
        usage = { inputTokens: chunk.usage.inputTokens.total ?? 0, outputTokens: chunk.usage.outputTokens.total ?? 0,
          ...(chunk.usage.inputTokens.cacheRead === undefined ? {} : { cacheReadTokens: chunk.usage.inputTokens.cacheRead }),
          ...(chunk.usage.inputTokens.cacheWrite === undefined ? {} : { cacheCreationTokens: chunk.usage.inputTokens.cacheWrite }) };
        responseOptions = chunk.providerMetadata;
        break;
      }
      case "error": throw chunk.error;
      case "response-metadata": break;
      case "raw": throw new ProviderError("Raw stream chunks are not enabled");
      default: throw new ProviderError(`Unsupported AI SDK stream content: ${chunk.type}`);
    }
  }
  if (!usage) throw new ProviderError("AI SDK stream ended without a finish event");
  const content: ContentBlock[] = [];
  for (const part of parts) {
    if (part.block.type === "text" && !part.block.text && !part.metadata) continue;
    content.push(part.block);
    if (part.metadata && part.block.type !== "native") content.push(native({ kind: "part-options", options: part.metadata }));
  }
  if (responseOptions) content.push(native({ kind: "response-options", options: responseOptions }));
  yield { type: "message_done", message: { role: "assistant", content }, usage };
}
