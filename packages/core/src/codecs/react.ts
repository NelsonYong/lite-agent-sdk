import { CodecError } from "../events";
import type { ToolCallCodec } from "../strategies";
import type { Message, ModelRequest, ToolSpec } from "../types";
import { deterministicCallId, messageText, promptMessages, toolCatalog } from "./prompt";

export interface ReactCodecOptions {
  instructions?: string;
}

const protocol = (tools: ToolSpec[], extra?: string) => [
  "Use one of these response formats:",
  "Action: tool_name\nAction Input: {\"argument\":\"value\"}",
  "Final Answer: your answer",
  "Call at most one tool per response. Available tools:",
  toolCatalog(tools),
  extra,
].filter(Boolean).join("\n");

export function reactCodec(opts: ReactCodecOptions = {}): ToolCallCodec {
  return {
    streaming: "buffer",
    encode(req: ModelRequest, tools: ToolSpec[]): ModelRequest {
      const { tools: _nativeTools, toolChoice: _toolChoice, ...base } = req;
      return {
        ...base,
        system: [req.system, protocol(tools, opts.instructions)].filter(Boolean).join("\n\n"),
        messages: promptMessages(
          req.messages,
          (calls) => `Action: ${calls[0]!.name}\nAction Input: ${JSON.stringify(calls[0]!.input ?? {})}`,
          (results) => results.map((r) => `Observation [${r.id}]${r.isError ? " (error)" : ""}: ${r.content}`).join("\n"),
        ),
      };
    },
    decode(message) {
      const raw = messageText(message).trim();
      const finalAt = raw.match(/(?:^|\n)Final Answer:\s*([\s\S]*)$/i);
      if (finalAt) return { text: finalAt[1]!.trim(), calls: [] };
      const action = raw.match(/(?:^|\n)Action:\s*([^\r\n]+)\s*[\r\n]+Action Input:\s*([\s\S]*)$/i);
      if (!action) {
        if (/(?:^|\n)Action:/i.test(raw)) throw new CodecError("ReAct Action is missing a valid Action Input JSON object");
        return { text: raw, calls: [] };
      }
      const name = action[1]!.trim();
      let input: unknown;
      try { input = JSON.parse(action[2]!.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim()) as unknown; }
      catch (error) { throw new CodecError(`invalid ReAct Action Input JSON: ${(error as Error).message}`); }
      return { text: "", calls: [{ id: deterministicCallId(raw, 0, name, input), name, input }] };
    },
    repairPrompt(error, attempt): Message {
      return {
        role: "user",
        content: `Your previous response did not match the required ReAct format (${error.message}). ` +
          `Return either Action + Action Input JSON, or Final Answer. Repair attempt ${attempt}.`,
      };
    },
  };
}
