import { z } from "zod";
import { defineTool, abortable } from "@lite-agent/core";
import type { Tool, UserAnswer, UserQuestion } from "@lite-agent/core";

function renderAnswer(a: UserAnswer): string {
  if (a.selected && a.selected.length) return a.selected.join(", ");
  if (a.text && a.text.length) return a.text;
  return "(no answer)";
}

export function askUserTool(): Tool {
  let tail: Promise<unknown> = Promise.resolve();
  return defineTool({
    name: "ask_user",
    description:
      "Ask the human a question and wait for their answer. Use for decisions, missing information, or confirmations. Provide `options` for a multiple-choice question (set `multiSelect` to allow several).",
    schema: z.object({
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
      multiSelect: z.boolean().optional(),
    }),
    security: { network: "none", filesystem: "none", sideEffects: "external" },
    execute: async ({ question, options, multiSelect }, ctx) => {
      if (!ctx.input)
        return "Error: ask_user is unavailable (no input handler configured).";
      const q: UserQuestion = {
        question,
        ...(options ? { options } : {}),
        ...(multiSelect ? { multiSelect } : {}),
      };
      const queued = tail.then(() => {
        ctx.signal.throwIfAborted();
        if (ctx.call) ctx.emit({ type: "input_request", call: ctx.call, question: q });
        return abortable(ctx.input!.request(q, ctx.signal), ctx.signal);
      });
      tail = queued.then(() => undefined, () => undefined);
      const answer = await abortable(queued, ctx.signal);
      ctx.emit({
        type: "input_resolved",
        id: ctx.call?.id ?? "ask_user",
        answer,
      });
      return renderAnswer(answer);
    },
  });
}
