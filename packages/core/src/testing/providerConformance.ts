import assert from "node:assert/strict";
import { ProviderError } from "../events";
import type { ModelProvider } from "../strategies";
import type {
  ModelChunk,
  ModelRequest,
  ToolCall,
  Usage,
} from "../types";

export type ProviderConformanceScenario =
  | { kind: "text"; deltas: string[]; usage: Usage }
  | {
      kind: "tool";
      textDeltas: string[];
      call: ToolCall;
      usage: Usage;
    }
  | { kind: "error"; error: unknown; afterText?: string }
  | { kind: "abort" };

export type ProviderConformanceFactory = (
  scenario: ProviderConformanceScenario,
) => ModelProvider;

const request: ModelRequest = {
  model: "conformance-model",
  messages: [{ role: "user", content: "conformance request" }],
};

async function collect(
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of provider.stream(request, signal)) chunks.push(chunk);
  return chunks;
}

function assertProviderError(error: unknown, status: number): boolean {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.status, status);
  return true;
}

export const providerConformance: Array<{
  name: string;
  run(make: ProviderConformanceFactory): Promise<void>;
}> = [
  {
    name: "has an id and emits exactly one final message_done",
    run: async (make) => {
      const provider = make({
        kind: "text",
        deltas: ["ok"],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      assert.ok(provider.id.length > 0);
      const chunks = await collect(provider);
      const doneIndexes = chunks.flatMap((chunk, index) =>
        chunk.type === "message_done" ? [index] : [],
      );
      assert.deepEqual(doneIndexes, [chunks.length - 1]);
    },
  },
  {
    name: "preserves text delta order in the final text block",
    run: async (make) => {
      const chunks = await collect(make({
        kind: "text",
        deltas: ["Hel", "lo"],
        usage: { inputTokens: 2, outputTokens: 2 },
      }));
      assert.deepEqual(
        chunks.filter((chunk) => chunk.type === "text_delta"),
        [
          { type: "text_delta", text: "Hel" },
          { type: "text_delta", text: "lo" },
        ],
      );
      const done = chunks.at(-1);
      assert.equal(done?.type, "message_done");
      if (done?.type === "message_done") {
        assert.deepEqual(done.message.content, [
          { type: "text", text: "Hello" },
        ]);
      }
    },
  },
  {
    name: "normalizes text followed by one tool call",
    run: async (make) => {
      const call: ToolCall = {
        id: "call-1",
        name: "echo",
        input: { value: "ok" },
      };
      const chunks = await collect(make({
        kind: "tool",
        textDeltas: ["Calling"],
        call,
        usage: { inputTokens: 3, outputTokens: 4 },
      }));
      const done = chunks.at(-1);
      assert.equal(done?.type, "message_done");
      if (done?.type === "message_done") {
        assert.deepEqual(done.message.content, [
          { type: "text", text: "Calling" },
          { type: "tool_call", ...call },
        ]);
      }
    },
  },
  {
    name: "reports normalized input and output usage",
    run: async (make) => {
      const chunks = await collect(make({
        kind: "text",
        deltas: ["usage"],
        usage: { inputTokens: 11, outputTokens: 7 },
      }));
      const done = chunks.at(-1);
      assert.equal(done?.type, "message_done");
      if (done?.type === "message_done") {
        assert.deepEqual(done.usage, { inputTokens: 11, outputTokens: 7 });
      }
    },
  },
  {
    name: "settles within 1000 ms after abort",
    run: async (make) => {
      const controller = new AbortController();
      const iterator = make({ kind: "abort" })
        .stream(request, controller.signal)[Symbol.asyncIterator]();
      const pending = iterator.next();
      let settled = false;
      const outcome = pending.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false, "provider stream settled before abort");
      controller.abort();

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          outcome,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("provider stream did not settle after abort")),
              1_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  },
  {
    name: "normalizes errors before and during streaming",
    run: async (make) => {
      const before = Object.assign(new Error("rate limited"), { status: 429 });
      await assert.rejects(
        () => collect(make({ kind: "error", error: before })),
        (error) => assertProviderError(error, 429),
      );

      const during = Object.assign(new Error("upstream failed"), { status: 503 });
      const seen: ModelChunk[] = [];
      await assert.rejects(async () => {
        for await (const chunk of make({
          kind: "error",
          error: during,
          afterText: "partial",
        }).stream(request)) {
          seen.push(chunk);
        }
      }, (error) => assertProviderError(error, 503));
      assert.deepEqual(seen, [{ type: "text_delta", text: "partial" }]);
    },
  },
];
