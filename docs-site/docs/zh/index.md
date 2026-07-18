---
pageType: home

hero:
  name: lite-agent
  text: 可插拔的 Agent 内核 SDK
  tagline: 轻量内核 = 可替换策略 + 洋葱式中间件 + 类型化事件流。同一套 Agent，驱动任意模型 —— 从 Claude 到本地小模型。
  image:
    src: /logo.svg
    alt: lite-agent
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/NelsonYong/lite-agent-sdk

features:
  - title: Provider 无关
    details: 一套归一化消息模型，覆盖 Anthropic、OpenAI 及 OpenAI 兼容的本地端点。换模型，不换 Agent。
    icon: 🔌
  - title: 九种可替换策略
    details: ModelProvider、ToolCallCodec、Tool、Compactor、PermissionPolicy、ApprovalHandler、InputHandler、Store、Sandbox —— 每个角色一个实现，即插即换。
    icon: 🧩
  - title: 洋葱式中间件
    details: 重试、权限、日志、压缩 —— 用 wrapModelCall / wrapToolCall 在模型与工具调用外层层叠加横切能力。
    icon: 🧅
  - title: 类型化事件流
    details: 每次运行产出类型化的 AgentEvent 流：文本增量、工具调用、审批、压缩 —— 供日志、UI 与指标消费。
    icon: 📡
  - title: 纵深防御
    details: 执行前的 glob 权限门控，加上 bash 外围的操作系统级沙箱（macOS Seatbelt / Linux bubblewrap）。
    icon: 🛡️
  - title: 本地模型就绪
    details: 可插拔的 tool-call 编解码器（native / JSON / ReAct）驱动本地小模型，并提供严格单机装配以获得最大控制力。
    icon: 💻
---
