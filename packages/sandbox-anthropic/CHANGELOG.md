# @lite-agent/sandbox-anthropic

## 0.1.0

### Minor Changes

- ce5c1e8: Initial 0.1.0 release of the pluggable agent-core SDK.
  - **@lite-agent/core** — event-driven kernel, strategy interfaces (provider/codec/tool/compactor/permission/approval/input/sandbox/store), onion middleware pipeline, normalized types, native codec, `policy()` + `permission()` gate.
  - **@lite-agent/provider** — Anthropic Messages API + OpenAI Chat Completions providers in one package (OpenAI also works with OpenAI-compatible / local endpoints). The example picks the provider by detecting the protocol from `LITE_AGENT_MODEL_ID`.
  - **lite-agent** — batteries layer: `createLiteAgent`/`query`, bash/file/todo + `ask_user` tools, skills loader, system prompt.
  - **@lite-agent/sandbox-anthropic** — OS-level sandbox adapter with graceful degradation.

- v0.1.0

### Patch Changes

- Updated dependencies [ce5c1e8]
- Updated dependencies
  - @lite-agent/core@0.1.0
