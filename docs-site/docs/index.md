---
pageType: home

hero:
  name: lite-agent
  text: The pluggable agent-core SDK
  tagline: A lightweight kernel built from swappable strategies, an onion middleware pipeline, and a typed event stream — drive any model, from Claude to local small models.
  image:
    src: /logo.svg
    alt: lite-agent
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/NelsonYong/lite-agent-sdk

features:
  - title: Provider-agnostic
    details: One normalized message model over Anthropic, OpenAI, and OpenAI-compatible local endpoints. Swap the model, keep the agent.
    icon: 🔌
  - title: Nine swappable strategies
    details: ModelProvider, ToolCallCodec, Tool, Compactor, PermissionPolicy, ApprovalHandler, InputHandler, Store, Sandbox — one implementation per role, hot-swappable.
    icon: 🧩
  - title: Onion middleware
    details: Retry, permission, logging, compaction — stack cross-cutting layers around model and tool calls with wrapModelCall / wrapToolCall.
    icon: 🧅
  - title: Typed event stream
    details: Every run yields a typed AgentEvent stream — text deltas, tool calls, approvals, compaction — for logging, UI, and metrics.
    icon: 📡
  - title: Defense in depth
    details: A glob-based permission gate before execution, plus an OS-level sandbox (macOS Seatbelt / Linux bubblewrap) around bash.
    icon: 🛡️
  - title: Local-model ready
    details: Pluggable tool-call codecs (native / JSON / ReAct) drive local small models, with a strict single-host assembly for maximum control.
    icon: 💻
---
