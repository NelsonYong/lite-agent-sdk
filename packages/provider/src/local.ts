import { isIP } from "node:net";
import { openai } from "./openai";
import type { OpenAIProviderOptions } from "./openai";
import type { ModelProvider } from "@lite-agent/core";

export type LocalRuntime = "ollama" | "vllm" | "lm-studio" | "llama.cpp";
export interface LocalOpenAIOptions extends OpenAIProviderOptions {
  runtime: LocalRuntime;
  /** Actual model context window, when known; used by the shared ContextEngine. */
  contextWindow?: number;
}

const ENDPOINTS: Record<LocalRuntime, string> = {
  ollama: "http://127.0.0.1:11434/v1",
  vllm: "http://127.0.0.1:8000/v1",
  "lm-studio": "http://127.0.0.1:1234/v1",
  "llama.cpp": "http://127.0.0.1:8080/v1",
};

/** Endpoint classification only; this does not isolate the provider process or its network. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "::1" ||
      (isIP(hostname) === 4 && hostname.split(".")[0] === "127");
  } catch { return false; }
}

/** Local endpoint convenience; creates a normal ModelProvider, never an agent. */
export function localOpenAI(opts: LocalOpenAIOptions): ModelProvider {
  const baseURL = opts.baseURL ?? ENDPOINTS[opts.runtime];
  if (!baseURL || !isLoopbackEndpoint(baseURL)) throw new Error("localOpenAI requires a loopback HTTP(S) endpoint; use openai() for remote services");
  if (opts.contextWindow !== undefined && (!Number.isSafeInteger(opts.contextWindow) || opts.contextWindow <= 0))
    throw new Error("contextWindow must be a positive safe integer");
  const provider = openai({ ...opts, apiKey: opts.apiKey ?? "local", baseURL });
  return opts.contextWindow === undefined ? provider : { ...provider, context: { ...provider.context, contextWindow: opts.contextWindow } };
}
