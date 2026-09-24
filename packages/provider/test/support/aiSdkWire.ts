import { EventStreamCodec } from "@smithy/eventstream-codec";

export type Wire = "chat" | "responses" | "anthropic" | "google" | "cohere" | "bedrock";
const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
export function aiSdkWire(wire: Wire, tool: boolean): Response {
  const input = '{"value":"ok"}';
  if (wire === "chat") return sse([
    { id: "r", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "lookup", arguments: input } }] } : { content: "ok" }, finish_reason: null }] },
    { id: "r", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, x_groq: { usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
  ]);
  if (wire === "google") return sse([{ candidates: [{ index: 0, content: { role: "model", parts: [tool ? { functionCall: { name: "lookup", args: { value: "ok" } }, thoughtSignature: "fixture-signature" } : { text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } }]);
  if (wire === "anthropic") {
    const events = [
      { type: "message_start", message: { id: "r", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: "c", name: "lookup", input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: input } : { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }
  if (wire === "responses") {
    const item = tool ? { type: "function_call", id: "fc", call_id: "c", name: "lookup", arguments: input, status: "completed" }
      : { type: "message", id: "msg", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
    return sse([
      { type: "response.created", response: { id: "r", object: "response", status: "in_progress", output: [], created_at: 1, model: "fixture" } },
      { type: "response.output_item.added", output_index: 0, item: tool ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } },
      ...(tool ? [
        { type: "response.function_call_arguments.delta", item_id: "fc", output_index: 0, delta: input },
        { type: "response.function_call_arguments.done", item_id: "fc", output_index: 0, arguments: input },
      ] : [{ type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "ok" }]),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "r", object: "response", status: "completed", created_at: 1, model: "fixture", output: [item], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
    ]);
  }
  if (wire === "cohere") return sse([
    { type: "message-start", id: "r" },
    ...(tool ? [
      { type: "tool-call-start", delta: { message: { tool_calls: { id: "c", type: "function", function: { name: "lookup", arguments: "" } } } } },
      { type: "tool-call-delta", delta: { message: { tool_calls: { function: { arguments: input } } } } },
      { type: "tool-call-end" },
    ] : [{ type: "content-start", index: 0, delta: { message: { content: { type: "text", text: "" } } } }, { type: "content-delta", index: 0, delta: { message: { content: { text: "ok" } } } }, { type: "content-end", index: 0 }]),
    { type: "message-end", delta: { finish_reason: tool ? "TOOL_CALL" : "COMPLETE", usage: { tokens: { input_tokens: 2, output_tokens: 1 }, billed_units: { input_tokens: 2, output_tokens: 1 } } } },
  ]);
  const events: Array<[string, unknown]> = [
    ["contentBlockStart", { contentBlockIndex: 0, start: tool ? { toolUse: { toolUseId: "c", name: "lookup" } } : {} }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: tool ? { toolUse: { input } } : { text: "ok" } }],
    ["contentBlockStop", { contentBlockIndex: 0 }],
    ["messageStop", { stopReason: tool ? "tool_use" : "end_turn" }],
    ["metadata", { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }],
  ];
  const codec = new EventStreamCodec((bytes) => new TextDecoder().decode(bytes), (value) => new TextEncoder().encode(value));
  const bytes = Buffer.concat(events.map(([type, value]) => codec.encode({ headers: {
    ":event-type": { type: "string", value: type }, ":message-type": { type: "string", value: "event" }, ":content-type": { type: "string", value: "application/json" },
  }, body: new TextEncoder().encode(JSON.stringify(value)) })));
  return new Response(bytes, { headers: { "content-type": "application/vnd.amazon.eventstream" } });
}
