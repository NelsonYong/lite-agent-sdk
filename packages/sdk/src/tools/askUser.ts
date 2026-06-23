import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool, UserAnswer, UserQuestion } from "@lite-agent/core";

function renderAnswer(a: UserAnswer): string {
  if (a.selected && a.selected.length) return a.selected.join(", ");
  if (a.text && a.text.length) return a.text;
  return "(no answer)";
}

export function askUserTool(): Tool {
  return defineTool({
    name: "ask_user",
    description:
      "Ask the human a question and wait for their answer. Use for decisions, missing information, or confirmations. Provide `options` for a multiple-choice question (set `multiSelect` to allow several).",
    schema: z.object({
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
      multiSelect: z.boolean().optional(),
    }),
    execute: async ({ question, options, multiSelect }, ctx) => {
      if (!ctx.input)
        return "Error: ask_user is unavailable (no input handler configured).";
      const q: UserQuestion = {
        question,
        ...(options ? { options } : {}),
        ...(multiSelect ? { multiSelect } : {}),
      };
      if (ctx.call)
        ctx.emit({ type: "input_request", call: ctx.call, question: q });
      const answer = await ctx.input.request(q);
      ctx.emit({
        type: "input_resolved",
        id: ctx.call?.id ?? "ask_user",
        answer,
      });
      return renderAnswer(answer);
    },
  });
}
