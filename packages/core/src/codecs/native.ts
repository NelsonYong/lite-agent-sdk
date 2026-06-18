import type { ToolCallCodec } from "../strategies";
import type { AssistantMessage, ModelRequest, ToolCall, ToolSpec } from "../types";
import { isToolCallBlock } from "../types";

export function nativeCodec(): ToolCallCodec {
  return {
    encode(req: ModelRequest, tools: ToolSpec[]): ModelRequest {
      return tools.length ? { ...req, tools } : req;
    },
    decode(message: AssistantMessage) {
      const calls: ToolCall[] = [];
      let text = "";
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
        else if (isToolCallBlock(block)) calls.push({ id: block.id, name: block.name, input: block.input });
      }
      return { text, calls };
    },
  };
}
