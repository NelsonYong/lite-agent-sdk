---
"@lite-agent-sdk/core": minor
"lite-agent-sdk": minor
"@lite-agent-sdk/provider": minor
"@lite-agent-sdk/sandbox-anthropic": minor
---

Initial 0.1.0 release of the pluggable agent-core SDK.

- **@lite-agent-sdk/core** — event-driven kernel, strategy interfaces (provider/codec/tool/compactor/permission/approval/input/sandbox/store), onion middleware pipeline, normalized types, native codec, `policy()` + `permission()` gate.
- **@lite-agent-sdk/provider** — Anthropic Messages API + OpenAI Chat Completions providers in one package (OpenAI also works with OpenAI-compatible / local endpoints). The example picks the provider by detecting the protocol from `LITE_AGENT_MODEL_ID`.
- **lite-agent-sdk** — batteries layer: `createLiteAgent`/`query`, bash/file/todo + `ask_user` tools, skills loader, system prompt.
- **@lite-agent-sdk/sandbox-anthropic** — OS-level sandbox adapter with graceful degradation.
