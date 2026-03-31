import { MessageParam, Model, ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { getClient } from "./client";
import { subagentTools, toolHandlers } from "../tools";
import { buildSubagentPrompt } from "../prompt/system";

const MAX_TURNS = 30;
const MAX_TOKENS = 8000;
const OUTPUT_LIMIT = 50000;

export async function runSubagent(prompt: string): Promise<string> {
  const system = buildSubagentPrompt(process.cwd());
  const messages: MessageParam[] = [{ role: "user", content: prompt }];

  let lastResponse;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await getClient().messages.create({
      model: process.env["MODEL_ID"] as Model,
      system,
      messages,
      tools: subagentTools,
      max_tokens: MAX_TOKENS,
    });

    messages.push({ role: "assistant", content: response.content });
    lastResponse = response;

    if (response.stop_reason !== "tool_use") break;

    const results: ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = toolHandlers[block.name];
        let output: string;
        try {
          output = handler
            ? await handler(block.input as any)
            : `Error: Unknown tool '${block.name}'`;
        } catch (e: any) {
          output = `Error: ${e.message}`;
        }
        console.log(`  [subagent] ${block.name}: ${output.slice(0, 120)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output).slice(0, OUTPUT_LIMIT),
        });
      }
    }

    messages.push({ role: "user", content: results });
  }

  if (!lastResponse) return "(subagent produced no response)";

  const texts: string[] = [];
  for (const block of lastResponse.content) {
    if (block.type === "text") texts.push(block.text);
  }
  return texts.join("") || "(no summary)";
}
