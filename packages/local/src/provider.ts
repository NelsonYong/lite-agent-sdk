import type { Message, ModelProvider, TokenEstimator } from "@lite-agent/core";
import { openai } from "@lite-agent/provider";
import { isIP } from "node:net";

export type LocalRuntime = "ollama" | "vllm" | "lm-studio" | "llama.cpp";

export interface LocalProviderCapabilities {
  endpoint: string;
  nativeTools: boolean;
  contextWindow: number;
  runtime?: LocalRuntime | "custom";
  tokenEstimator?: TokenEstimator;
  tokenizerAccuracy?: "exact" | "approximate";
  probe?: (signal?: AbortSignal) => Promise<void>;
  tokenize?: (model: string, messages: Message[], signal?: AbortSignal) => Promise<number>;
}

export interface LocalModelProvider extends ModelProvider {
  readonly local: LocalProviderCapabilities;
}

export interface LocalOpenAIOptions {
  runtime: LocalRuntime;
  contextWindow: number;
  baseURL?: string;
  apiKey?: string;
  maxRetries?: number;
  nativeTools?: boolean;
  tokenEstimator?: TokenEstimator;
  probeTimeoutMs?: number;
}

const ENDPOINTS: Record<LocalRuntime, string> = {
  ollama: "http://127.0.0.1:11434/v1",
  vllm: "http://127.0.0.1:8000/v1",
  "lm-studio": "http://127.0.0.1:1234/v1",
  "llama.cpp": "http://127.0.0.1:8080/v1",
};

export function isLoopbackEndpoint(endpoint: string): boolean {
  if (endpoint.startsWith("unix:")) return true;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost"
      || hostname === "::1"
      || (isIP(hostname) === 4 && hostname.split(".")[0] === "127");
  } catch { return false; }
}

export function markLocalProvider(
  provider: ModelProvider,
  capabilities: LocalProviderCapabilities,
): LocalModelProvider {
  if (!Number.isFinite(capabilities.contextWindow) || capabilities.contextWindow <= 0)
    throw new Error("local provider contextWindow must be a positive finite number");
  return Object.assign(provider, { local: { ...capabilities } });
}

function endpoint(baseURL: string, leaf: string): string {
  const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  return new URL(leaf, base).toString();
}

async function parseTokenCount(response: Response): Promise<number> {
  if (!response.ok) throw new Error(`tokenizer probe failed: HTTP ${response.status}`);
  const body = await response.json() as { count?: unknown; tokens?: unknown };
  if (typeof body.count === "number") return body.count;
  if (Array.isArray(body.tokens)) return body.tokens.length;
  throw new Error("tokenizer response has neither count nor tokens");
}

export function localOpenAI(opts: LocalOpenAIOptions): LocalModelProvider {
  const baseURL = opts.baseURL ?? ENDPOINTS[opts.runtime];
  const provider = openai({ apiKey: opts.apiKey ?? "local", baseURL, maxRetries: opts.maxRetries });
  const timeout = opts.probeTimeoutMs ?? 3000;
  const probe = async (outerSignal?: AbortSignal) => {
    const signal = outerSignal ?? AbortSignal.timeout(timeout);
    const headers = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : undefined;
    const response = await fetch(endpoint(baseURL, "models"), { headers, signal, redirect: "error" });
    if (!response.ok) throw new Error(`local model probe failed: HTTP ${response.status}`);
  };
  const tokenize = opts.runtime === "vllm" || opts.runtime === "llama.cpp"
    ? async (model: string, messages: Message[], signal?: AbortSignal) => {
        const prompt = JSON.stringify(messages);
        const body = opts.runtime === "vllm" ? { model, prompt } : { content: prompt };
        const response = await fetch(new URL("../tokenize", endpoint(baseURL, ".")).toString(), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(timeout), redirect: "error",
        });
        return parseTokenCount(response);
      }
    : undefined;
  return markLocalProvider(provider, {
    endpoint: baseURL,
    nativeTools: opts.nativeTools ?? false,
    contextWindow: opts.contextWindow,
    runtime: opts.runtime,
    tokenEstimator: opts.tokenEstimator,
    tokenizerAccuracy: opts.tokenEstimator || tokenize ? "exact" : "approximate",
    probe,
    tokenize,
  });
}
