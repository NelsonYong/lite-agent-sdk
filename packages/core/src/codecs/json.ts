import { CodecError } from "../events";
import type { ToolCallCodec } from "../strategies";
import type { Message, ModelRequest, ToolCall, ToolSpec } from "../types";
import { deterministicCallId, extractJson, messageText, promptMessages, toolCatalog } from "./prompt";

export interface JsonCodecOptions {
  /** Extra protocol guidance appended after the built-in instructions. */
  instructions?: string;
}

const protocol = (tools: ToolSpec[], extra?: string) => [
  "Use exactly one JSON object as your complete response.",
  'Call tools with {"type":"tool_calls","calls":[{"name":"tool_name","input":{}}]}.',
  'Return a final answer with {"type":"final","text":"answer"}.',
  "Do not wrap the object in prose. Available tools:",
  toolCatalog(tools),
  extra,
].filter(Boolean).join("\n");

function asInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value) as unknown; } catch { throw new CodecError("tool arguments must be valid JSON"); }
}

function parseCalls(payload: Record<string, unknown>, raw: string): ToolCall[] | undefined {
  let candidates: unknown = payload.calls ?? payload.tool_calls;
  if (candidates === undefined && (payload.tool !== undefined || payload.name !== undefined)) {
    candidates = [{
      name: payload.tool ?? payload.name,
      input: payload.input ?? payload.arguments ?? payload.args,
    }];
  }
  if (candidates === undefined) return undefined;
  if (!Array.isArray(candidates) || candidates.length === 0)
    throw new CodecError("tool_calls.calls must be a non-empty array");
  return candidates.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object")
      throw new CodecError(`tool call ${index} must be an object`);
    const call = candidate as Record<string, unknown>;
    const name = call.name ?? call.tool;
    if (typeof name !== "string" || name.trim() === "")
      throw new CodecError(`tool call ${index} is missing a name`);
    const input = asInput(call.input ?? call.arguments ?? call.args ?? {});
    const id = typeof call.id === "string" && call.id ? call.id : deterministicCallId(raw, index, name, input);
    return { id, name, input };
  });
}

export function jsonCodec(opts: JsonCodecOptions = {}): ToolCallCodec {
  return {
    streaming: "buffer",
    encode(req: ModelRequest, tools: ToolSpec[]): ModelRequest {
      const { tools: _nativeTools, toolChoice: _toolChoice, ...base } = req;
      return {
        ...base,
        system: [req.system, protocol(tools, opts.instructions)].filter(Boolean).join("\n\n"),
        messages: promptMessages(
          req.messages,
          (calls) => JSON.stringify({ type: "tool_calls", calls: calls.map((c) => ({ name: c.name, input: c.input })) }),
          (results) => JSON.stringify({ type: "tool_results", results }),
        ),
      };
    },
    decode(message) {
      const raw = messageText(message).trim();
      const candidate = extractJson(raw);
      if (!candidate) return { text: raw, calls: [] };
      let payload: unknown;
      try { payload = JSON.parse(candidate) as unknown; }
      catch (error) { throw new CodecError(`invalid JSON tool protocol: ${(error as Error).message}`); }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload))
        throw new CodecError("JSON tool protocol must be an object");
      const object = payload as Record<string, unknown>;
      const calls = parseCalls(object, candidate);
      if (calls) return { text: "", calls };
      if (object.type === "tool_calls") throw new CodecError("tool_calls response is missing calls");
      if (object.type === "final" || typeof object.text === "string") {
        if (typeof object.text !== "string") throw new CodecError("final response is missing text");
        return { text: object.text, calls: [] };
      }
      return { text: raw, calls: [] };
    },
    repairPrompt(error, attempt): Message {
      return {
        role: "user",
        content: `Your previous response did not match the required JSON protocol (${error.message}). ` +
          `Retry with one valid JSON object only. Repair attempt ${attempt}.`,
      };
    },
  };
}
