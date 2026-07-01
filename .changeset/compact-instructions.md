---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

Steer manual compaction with free-text instructions, matching Claude Code's `/compact <instructions>`.

`LiteAgent.compact(instructions?)` and `Compactor.maybeCompact(messages, usage, instructions?)` gain an optional instruction string. `llmCompactor` appends it to the summary prompt (append/emphasize, not override) so it biases what the summary preserves. Structural compactors and automatic/proactive compaction ignore it — only a manual `compact()` forwards it. The parameter is optional, so existing `Compactor` implementations and call sites are unaffected.
