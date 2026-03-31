import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { MessageParam, Model, TextBlock, ToolResultBlockParam, ToolUseBlockParam } from "@anthropic-ai/sdk/resources";
import { getClient } from "./client";

const TRANSCRIPT_DIR = resolve(process.cwd(), ".transcripts");

const KEEP_RECENT = 3;
const COMPACT_THRESHOLD = 500;
// 压缩后保留的预览字符数，让模型保有结果的大致印象
const PREVIEW_LENGTH = 200;
// 触发压缩的 token 阈值，低于此值时跳过压缩以节省处理开销
const COMPACT_TOKEN_TRIGGER = 80_000;

/**
 * 消息压缩入口。
 * 在每次 LLM 调用前调用，将历史消息中较早的 tool result 内容替换为占位符，
 * 以减少 token 消耗，同时保留最近 KEEP_RECENT 条结果供模型参考。
 *
 * @param inputTokens 上一轮 LLM 响应中 usage.input_tokens 的值，
 *                    未超过 COMPACT_TOKEN_TRIGGER 时直接返回原消息，避免不必要的处理。
 */
export function microCompact(messages: MessageParam[], inputTokens = 0): MessageParam[] {
  if (inputTokens < COMPACT_TOKEN_TRIGGER) return messages;

  const toolResultIds = collectToolResultIds(messages);
  if (toolResultIds.length <= KEEP_RECENT) return messages;

  const compactIds = new Set(toolResultIds.slice(0, -KEEP_RECENT));
  const toolNameMap = buildToolNameMap(messages);

  return messages.map((msg) => compactMessage(msg, compactIds, toolNameMap));
}


/**
 * 深度压缩：将整段历史对话交给 LLM 生成摘要，替换为两条精简消息。
 * 同时将原始消息以 JSONL 格式保存到本地，防止信息永久丢失。
 * 适合在 token 占用极高（如 > 90%）时作为最后手段触发。
 */
export async function autoCompact(messages: MessageParam[]): Promise<MessageParam[]> {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = resolve(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  writeFileSync(transcriptPath, messages.map((m) => JSON.stringify(m)).join('\n'));
  console.log(`[transcript saved: ${transcriptPath}]`);

  const conversationText = JSON.stringify(messages).slice(0, 80_000);
  const response = await getClient().messages.create({
    model: process.env["MODEL_ID"] as Model,
    messages: [{
      role: 'user',
      content: `Summarize this conversation for continuity. Include: 1) What was accomplished, 2) Current state, 3) Key decisions made. Be concise but preserve critical details.\n\n${conversationText}`,
    }],
    max_tokens: 2000,
  });

  const summaryBlock = response.content.find((b): b is TextBlock => b.type === 'text');
  const summary = summaryBlock?.text ?? '(no summary)';

  return [
    { role: 'user', content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}` },
    { role: 'assistant', content: 'Understood. I have the context from the summary. Continuing.' },
  ];
}




/**
 * 按顺序收集所有 user 消息中 tool_result 的 tool_use_id，
 * 用于后续判断哪些结果需要被压缩。
 */
function collectToolResultIds(messages: MessageParam[]): string[] {
  return messages.flatMap((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return [];
    return msg.content
      .filter((part): part is ToolResultBlockParam => part.type === 'tool_result')
      .map((part) => part.tool_use_id);
  });
}

/**
 * 从 assistant 消息中提取 tool_use_id → tool_name 的映射，
 * 用于在压缩时生成可读的占位符文本（如 "[Compacted: used read_file — \"...\"]"）。
 */
function buildToolNameMap(messages: MessageParam[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const toolUse = block as ToolUseBlockParam;
        map[toolUse.id] = toolUse.name;
      }
    }
  }
  return map;
}

/**
 * 对单条消息做压缩处理，返回新对象（不修改原始消息）。
 * 仅处理 user 消息中属于 compactIds 且内容超过 COMPACT_THRESHOLD 的 tool_result，
 * 压缩后保留前 PREVIEW_LENGTH 字符的预览，其余部分原样保留。
 */
function compactMessage(
  msg: MessageParam,
  compactIds: Set<string>,
  toolNameMap: Record<string, string>,
): MessageParam {
  if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;

  const content = msg.content.map((part) => {
    if (
      part.type === 'tool_result' &&
      compactIds.has(part.tool_use_id) &&
      typeof part.content === 'string' &&
      part.content.length > COMPACT_THRESHOLD
    ) {
      const toolName = toolNameMap[part.tool_use_id] ?? 'unknown';
      const preview = part.content.slice(0, PREVIEW_LENGTH);
      const compactedContent = `[Compacted: used ${toolName} — "${preview}..."]`;
      return { ...part, content: compactedContent } satisfies ToolResultBlockParam;
    }
    return part;
  });

  return { ...msg, content };
}