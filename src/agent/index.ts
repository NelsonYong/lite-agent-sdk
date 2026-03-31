import {
  MessageParam,
  Model,
  TextBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources";
import { getClient } from "./client";
import { mainAgentTools, toolHandlers } from "../tools";
import { autoCompact, microCompact } from "./compact";
import { BG } from "./background";
import { BUS } from "./agentTeam";

const COMPACT_MAX_TOKENS_THRESHOLD = 150_000;

export async function liteAgent({
  messages: initialMessages,
  system,
  forceTool,
  signal,
}: {
  messages: MessageParam[];
  system?: string;
  forceTool?: string;
  signal?: AbortSignal;
}) {
  let messages = initialMessages;
  let lastInputTokens = 0;
  let roundsSinceTodo = 0;

  while (true) {
    // ESC 中断检查
    if (signal?.aborted) {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "[interrupted by user]" }],
      });
      return;
    }

    // 每次调用 llm 都将 tool result 替换成标识符
    messages = microCompact(messages, lastInputTokens);

    // 超过 150k 时触发深度压缩：调用 LLM 生成摘要，替换全部历史消息
    if (lastInputTokens > COMPACT_MAX_TOKENS_THRESHOLD) {
      console.log("[auto_compact triggered]");
      messages = await autoCompact(messages);
    }

    // 获取并清空通知队列
    const notifs = BG.drainNotifications();
    if (notifs.length && messages.length) {
      const notifText = notifs
        .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
        .join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted background results.",
      });
    }

    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }

    // 调用 llm
    let response;
    try {
      response = await getClient().messages.create(
        {
          messages,
          model: process.env["MODEL_ID"] as Model,
          max_tokens: 8000,
          system,
          tools: mainAgentTools,
          tool_choice: forceTool ? { type: "tool", name: forceTool } : undefined,
        },
        { signal },
      );
    } catch (e: any) {
      if (signal?.aborted) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "[interrupted by user]" }],
        });
        return;
      }
      throw e;
    }
    lastInputTokens = response.usage.input_tokens;
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    const results: (ToolResultBlockParam | TextBlockParam)[] = [];
    let usedTodo = false;
    let manualCompact = false;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      if (signal?.aborted) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "[interrupted by user]",
        });
        continue;
      }

      const input = block.input as any;
      let output: string;

      try {
        if (block.name === "compact") {
          manualCompact = true;
          output = "Compressing...";
        } else {
          const handler = toolHandlers[block.name];
          output = handler
            ? await handler(input)
            : `Error: Handler not found for tool ${block.name}`;
          if (block.name === "todo") usedTodo = true;
        }
      } catch (e: any) {
        output = `Error: ${e.message}`;
        console.log(`> ${block.name}: ${output}`);
      }

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output!,
      });
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.unshift({
        type: "text",
        text: "<reminder>Update your todos.</reminder>",
      });
    }

    if (manualCompact) {
      console.log("[manual compact]");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }

    messages.push({ role: "user", content: results });
  }
}
