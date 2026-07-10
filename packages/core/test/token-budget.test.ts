import { expect, test } from "vitest";
import { tokenBudgetCompactor } from "../src/compaction/tokenBudget";
import type { Message } from "../src/types";

test("tokenBudgetCompactor drops whole old turns and preserves the newest turn", async () => {
  const messages: Message[] = [
    { role: "user", content: "old" },
    { role: "assistant", content: [{ type: "tool_call", id: "a", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", id: "a", content: "old-result" }] },
    { role: "user", content: "new" },
    { role: "assistant", content: [{ type: "text", text: "new-answer" }] },
  ];
  const compact = tokenBudgetCompactor({ maxTokens: 2, estimator: (m) => m.length });
  const out = await compact.maybeCompact(messages, { inputTokens: 0, outputTokens: 0 });
  expect(out.messages[0]).toMatchObject({ role: "user", content: expect.stringContaining("omitted") });
  expect(out.messages.slice(1)).toEqual(messages.slice(3));
});
