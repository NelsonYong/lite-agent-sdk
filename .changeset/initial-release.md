---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
"@lite-agent/provider-anthropic": minor
"@lite-agent/sandbox-anthropic": minor
---

Initial 0.1.0 release of the pluggable agent-core SDK.

- **@lite-agent/core** — event-driven kernel, strategy interfaces (provider/codec/tool/compactor/permission/approval/input/sandbox/store), onion middleware pipeline, normalized types, native codec, `policy()` + `permission()` gate.
- **@lite-agent/provider-anthropic** — Anthropic Messages API provider.
- **@lite-agent/sdk** — batteries layer: `createLiteAgent`/`query`, bash/file/todo + `ask_user` tools, skills loader, system prompt.
- **@lite-agent/sandbox-anthropic** — OS-level sandbox adapter with graceful degradation.
