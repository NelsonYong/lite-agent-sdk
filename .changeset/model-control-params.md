---
"@lite-agent/core": minor
"@lite-agent/provider": minor
"@lite-agent/sdk": minor
---

Add model sampling and tool-selection controls

`ModelRequest` gains `temperature`, `topP`, `toolChoice`, and `seed`, threaded through
`KernelConfig` → `createAgent` → `createLiteAgent` / `query` (and inherited by subagents).
`toolChoice` is normalized as `"auto" | "none" | "required" | { tool: string }`.

Both providers forward the new fields: the OpenAI mapping emits `temperature` / `top_p` /
`seed` / `tool_choice`; the Anthropic mapping emits `temperature` / `top_p` and maps
`tool_choice` to its `auto` / `none` / `any` / `tool` shapes (`seed` is unsupported by
Anthropic and intentionally ignored). `tool_choice` is only sent when tools are present.
