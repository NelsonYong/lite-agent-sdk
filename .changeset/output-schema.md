---
"@lite-agent/sdk": minor
---

Add `outputSchema` for structured final answers

`createLiteAgent` and `query` accept an `outputSchema` (a Zod object schema). When set,
a `final_answer` tool whose parameters are that schema is registered and the model is
instructed to call it when done. The validated arguments surface as `result.output`
(typed via the new `LiteAgentResult`). Because the answer travels through a tool call
rather than free text, it is robust for reasoning models (whose replies contain `<think>`
blocks) and small local models. Subagents do not inherit `outputSchema` — they still
return their answer as text.
