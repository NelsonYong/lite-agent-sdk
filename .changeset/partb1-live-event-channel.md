---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

Stream tool-phase events to consumers in real time (completion order) via an internal push channel, instead of buffering them until the tool pool drains. Subagent events are now forwarded live to the parent event stream, tagged with an optional `agentId` so UIs can route concurrent subagents to their own lanes. The model-facing context is unchanged: tool_result blocks are still assembled in input order and id-matched. Additive — consumers that ignore `agentId` and don't depend on concurrent-tool event ordering are unaffected.
