import type { ModelProvider } from "../strategies";
import type { AssistantMessage, ModelChunk, Usage } from "../types";

export type FakeTurn = { text?: string; message: AssistantMessage; usage?: Usage };

export function fakeProvider(turns: FakeTurn[]): ModelProvider {
  let i = 0;
  return {
    id: "fake",
    async *stream(): AsyncIterable<ModelChunk> {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      if (!turn) throw new Error("fakeProvider: no turns configured");
      if (turn.text) for (const ch of turn.text) yield { type: "text_delta", text: ch };
      yield {
        type: "message_done",
        message: turn.message,
        usage: turn.usage ?? { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}
