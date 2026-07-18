---
pageType: home

hero:
  name: Lite Agent
  text: A complete agent runtime
  tagline: Batteries included, yet fully decomposable — run an agent in three lines with query(), or assemble your own from the kernel primitives. One kernel, every model.
  actions:
    - theme: brand
      text: Get Started
      link: /sdk/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/NelsonYong/lite-agent-sdk

features:
  - title: Provider-agnostic
    details: Anthropic, OpenAI, or local endpoints — one message model. Swap the model, keep the agent.
  - title: Nine swappable strategies
    details: From ModelProvider to Sandbox — one implementation per role, hot-swappable.
  - title: Onion middleware
    details: Retry, permission, compaction — layered around every call.
  - title: Typed event stream
    details: One run, one AgentEvent stream — for logging, UI, and metrics.
  - title: Durable sessions
    details: Event-sourced sessions you can resume and rewind — restarts lose nothing, mistakes roll back.
  - title: Parallel subagents
    details: Isolated subagent sessions work subtasks in parallel; the parent context stays clean.
  - title: Structured output
    details: One Zod schema turns the final answer into typed, validated data.
  - title: Defense in depth
    details: A permission gate before execution, an OS sandbox around it.
  - title: Local-model ready
    details: Pluggable codecs give local small models real tool calls.
---

