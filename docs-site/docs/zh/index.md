---
pageType: home

hero:
  name: Lite Agent
  text: 完整的 Agent 运行时
  tagline: 开箱即用，也任你拆解 —— 三行 query() 跑起一个 agent，或用内核原语组装自己的。一套内核，驱动任意模型。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/sdk/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/NelsonYong/lite-agent-sdk

features:
  - title: Provider 无关
    details: Anthropic、OpenAI 与本地端点，一套消息模型。换模型，不换 Agent。
  - title: 九种可替换策略
    details: 从 ModelProvider 到 Sandbox，每个角色一个实现，即插即换。
  - title: 洋葱式中间件
    details: 重试、权限、压缩 —— 在每次调用外层层叠加。
  - title: 类型化事件流
    details: 一次运行，一条 AgentEvent 流。日志、UI、指标，各取所需。
  - title: 会话持久化
    details: 事件溯源会话，可恢复、可回溯 —— 重启不丢，错了能回滚。
  - title: 并行子代理
    details: 隔离会话的子代理并行处理子任务，主上下文保持干净。
  - title: 结构化输出
    details: 一个 Zod schema，把最终回答变成类型化、可校验的数据。
  - title: 纵深防御
    details: 执行前的权限门控，运行时的 OS 级沙箱。
  - title: 本地模型就绪
    details: 可插拔 codec，让本地小模型也会调用工具。
---

