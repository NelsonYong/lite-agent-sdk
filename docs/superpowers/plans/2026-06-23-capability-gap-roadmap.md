# lite-agent-sdk 能力补齐路线图（按优先级）

> 来源：2026-06-23 代码审计 + 联网调研（22 来源 / 25 条对抗式验证 / 23 确认）。
> 对标：Claude Agent SDK、OpenAI Agents SDK、LangGraph、Vercel AI SDK；编码 agent：Claude Code、Codex CLI、opencode。

## 优先级判定标准

- **P0** — 业界标配 **且** 你已有接口桩/已规划，补线成本低、价值高。先做。
- **P1** — 业界标配但属新增能力，需要新抽象层，价值高。
- **P2** — 增强项，提升健壮性/适配面，非阻塞。
- **P3** — 设计上的 non-goal 或低频需求，按需再议。

每项给出：缺口、现状证据（file）、改动范围、验收标准、工作量（S<1d / M 1-3d / L >3d）、依赖。

---

## P0 — 把已声明的桩接上线（最高性价比）

这三项是「你自己的策略接口已存在但 kernel 从未调用」。补的是接线，不是新架构，完全契合现有 9 策略 + 中间件模型。

### P0-1 上下文压缩 Compactor（长会话）🟡 确定性层已完成（2026-06-23，TDD）
- **已实现（积木 + 管道）**：`core/src/compaction/` —— `CompactPass` 接口 + `runPipeline`（数据流串联）+ `estimateTokens`；`microPass`(L2，旧 tool_result→占位、不删块、配对安全) + `snipPass`(L1，回合级裁中段、不破坏 tool_call↔tool_result 配对)；`defaultCompactor()` 装配管道→固定 `Compactor` 接口；`compaction()` `beforeModel` block；`compactor?` 贯穿 `createLiteAgent`/`query`。零 kernel 改动，12 个新测试全绿。
- **reactiveCompact 应急层已完成（2026-06-23，TDD）**：`reactiveCompaction()`（`wrapModelCall` block，捕获 413/`prompt_too_long` → `reactiveTrim` 回合级激进裁剪、保留最近若干回合+占位、**LLM-free** → 重试一次）；配套两处 additive kernel 调整:① `codec.encode` 移进 `ModelCall` 闭包(重试用当前 messages 重新编码);② model 调用后 `messages = ctx.messages` 重新同步(让 wrapModelCall 改写的 messages 进入结果/持久化)。createLiteAgent 设 `compactor` 时自动叠加 `compaction()` + `reactiveCompaction()`(proactive+reactive 一体)。+8 测试。
- **待做（后续轮次，"贵"的层）**：① L3 toolResultBudget 落盘 + 重读工具；② L4 autoCompact（LLM 全量摘要，作为一个 `CompactPass` 热插拔进 `defaultCompactor` 的 `passes`）。
- ~~**缺口**：`Compactor` 接口 + `compaction` 事件已存在，但 kernel 无调用点；`KernelConfig` 无 `compactor` 字段。长会话会直接撑爆上下文。~~
- **现状**：`packages/core/src/strategies.ts`（`Compactor.maybeCompact`）、`events.ts`（`compaction` variant）有定义；`kernel.ts` 零引用。
- **改动**：
  - `KernelConfig` 增 `compactor?: Compactor`；kernel 在 `beforeModel` 阶段按 token 阈值调用 `maybeCompact`，替换 messages 并 `emit("compaction", …)`。
  - 实现 `defaultCompactor()`：micro（裁剪超长 tool result）+ auto（阈值触发，保留首尾 + 摘要中段）。
  - SDK 层 `createLiteAgent` 暴露 `compaction` 配置。
- **验收**：构造超阈值消息序列，断言触发 `compaction` 事件、messages 缩短、`before/after` token 记录正确；golden 事件流测试。
- **工作量**：M ｜ **依赖**：需 usage/token 计量（见 P2-3，可先用 provider 返回的 usage 粗算）。

### P0-2 会话持久化 + resume（Store）✅ 已完成（2026-06-23，TDD）
- **已实现**：`memoryStore()`（core）+ `jsonlStore({dir})`（sdk，文件级 `<id>.jsonl`，含路径穿越防护）；kernel 起始 `load(sessionId)` 续接历史、每个 tool-turn + run 结束 `save`；`store` 贯穿 `createAgent`/`createLiteAgent`/`query`，`memoryStore`/`jsonlStore` 已导出。新增 13 个测试全绿；core/sdk/provider/sandbox typecheck 通过。（`fork` 尚未做，留作后续。）
- ~~**缺口**：`Store` 接口存在但 kernel 不 load/save；状态仅存活于单次 `runKernel`，进程重启即丢，无 resume/fork。~~
- **现状**：`strategies.ts`（`Store.load/save`）有定义；`kernel.ts`、`createAgent.ts` 中 sessionId 自增但不落盘；grep `resume/.jsonl` 零命中。
- **改动**：
  - `KernelConfig` 增 `store?: Store`；kernel run 起始 `load(sessionId)`，turn 末 `save(sessionId, messages)`。
  - 实现 `memoryStore()` 与 `jsonlStore({ dir })`（仿 Claude Code `~/.claude/projects/*.jsonl` 落盘）。
  - SDK/CLI 暴露 `resume(sessionId)`；可选 `fork(sessionId)`（复制为新 id，探索分支）。
- **验收**：保存会话→新进程 `load`→续跑，断言历史完整、tool 状态连续；fork 后两分支独立。
- **工作量**：M ｜ **依赖**：无。

### P0-3 retry 中间件（健壮性）✅ 已完成（2026-06-23，TDD）
- **已实现**：`retry({ maxRetries, backoff, retryOn })`（core 新 `retry.ts`，独立 `wrapModelCall` block，经 `use: [retry()]` 挂载，零 kernel 改动）；默认仅重试 transient `ProviderError`（408/409/425/429/5xx + 无 status 的网络错误），首 chunk 已 emit 后不再重试（避免重复输出）。4 个测试全绿。
- ~~**缺口**：provider 错误（429/5xx/网络抖动）无重试，长跑易中断。Phase 4 已规划未做。~~
- **现状**：`middleware.ts` 有 `wrapModelCall` 钩子可承载；无 retry 实现。
- **改动**：实现 `retry({ maxRetries, backoff, retryOn })` 作为 `wrapModelCall` 中间件，识别 `ProviderError.status`。
- **验收**：注入 fakeProvider 抛 429→断言按退避重试 N 次后成功/最终抛出。
- **工作量**：S ｜ **依赖**：无。

---

## P1 — 新增能力（业界一等公民，需新层）

### P1-1 MCP（Model Context Protocol）支持 ★最大单点缺口
- **缺口**：完全没有 MCP（grep `mcp` 零命中）。Claude Agent SDK（`mcpServers` + MCP-as-hooks + Elicitation）、OpenAI Agents SDK（Hosted/StreamableHTTP/SSE/stdio 四传输 + 工具过滤）都是一等公民。当前用户要接任何 MCP server 都得手写 `Tool` 包装。
- **改动**：
  - 新增 MCP 客户端适配层（建议新包 `@lite-agent-sdk/mcp` 或 sdk 子模块），把远端 MCP 工具动态注册为现有 `Tool`（zod schema 由 MCP JSON Schema 反推或透传）。
  - 传输优先级：**stdio + streamable-HTTP**（OpenAI 已弃用 SSE，转 streamable-HTTP，故 SSE 可缓做）。
  - 工具过滤：静态 allow/block + 命名冲突前缀（`server__tool`）。
- **验收**：起一个本地 stdio MCP server（如 filesystem），断言工具被发现、注册、可调用，且经过现有 permission gate。
- **工作量**：L ｜ **依赖**：复用现有 `Tool`/permission；**需你拍板**是「一等策略」还是「用户land 包装」（见文末决策）。

### P1-2 子 agent / agent-as-tool（多 agent 编排）
- **缺口**：只有单层扁平 loop，无 parent/child、无 `parent_tool_use_id`。Claude Agent SDK（独立上下文 + 并发 + 可 resume transcript）、OpenAI（handoffs + agents-as-tools）。
- **改动**（最小可用先行）：
  - **先做 agent-as-tool**：把一个 `createLiteAgent` 实例包成一个 `Tool`，父 agent 调用它、只回传最终消息（天然上下文隔离，省 token）。
  - 后续可选：subagent 注册（`agents` 配置 + 独立 transcript 落盘，复用 P0-2 Store）、并发执行。
- **验收**：父 agent 通过工具调用子 agent，断言子 agent 上下文隔离、仅 final message 返回父。
- **工作量**：M（agent-as-tool）/ L（完整 subagent）｜ **依赖**：subagent transcript 复用 P0-2。

### P1-3 可观测性：OTel GenAI adapter（不进 kernel）
- **缺口**：自定义 `AgentEvent` 不映射任何 OTel；无 exporter、无 token/cost 计量。OTel GenAI 语义约定（`invoke_agent`→子 `chat`/`execute_tool` span + `gen_ai.*` 属性）已成事实标准；Vercel AI SDK 内置；Claude Code/Codex/Copilot 已导出。
- **改动**：写**适配中间件/订阅器**，把现有事件流映射成 OTel span（保持核心轻量，不在 kernel 里硬塞 OTel）。映射：`turn_start`→`invoke_agent`，model 调用→`chat` 子 span，`tool_use/tool_result`→`execute_tool` 子 span，attributes 填 `gen_ai.request.model`、`gen_ai.usage.input_tokens/output_tokens`、`gen_ai.response.finish_reasons`。
- **验收**：跑一轮 agent，导出到内存 exporter，断言 span 层级与属性符合约定。
- **工作量**：M ｜ **依赖**：token 计量（P2-3）。**注意**：OTel GenAI 约定仍 experimental（Development 状态），是事实标准非冻结规范——可接受小幅变动。

---

## P2 — 增强项

### P2-1 结构化最终输出（typed result）
- **缺口**：工具**入参**有 zod，但最终答案无 `response_format`/`outputSchema`，`RunResult` 仅自由文本。对标 Vercel `generateObject`、OpenAI structured outputs、Pydantic AI typed result。
- **改动**：`query/run` 可选 `outputSchema: ZodType`；provider mapping 注入 `response_format`/`json_schema`（Anthropic 用 tool 强制、OpenAI 用 `response_format`）；最终用 zod 校验并返回 typed 结果。
- **验收**：给定 schema，断言最终结果通过 zod 校验且类型正确；不符时重试/报错。
- **工作量**：M ｜ **依赖**：无。

### P2-2 本地模型 codec（jsonCodec / reactCodec）
- **缺口**：只有 `nativeCodec`；弱/本地模型不原生支持 tool call 时无兜底。Phase 5 已规划。
- **改动**：`jsonCodec()`（system prompt 指示输出 JSON 工具调用 + 解析）、`reactCodec()`（Thought/Action 正则解析）、`maxDecodeRetries`。
- **验收**：fakeProvider 产出非原生格式→断言正确 decode 为 ToolCall，解析失败按 retry。
- **工作量**：M ｜ **依赖**：无。

### P2-3 usage / cost 计量
- **缺口（已修正）**：基础 token 聚合**其实已实现**——`kernel.ts:35,68-71` 跨 turn 累加 input/output tokens 并写入 `RunResult.usage`（`kernel.ts:114`）。真正缺的是：① 单次 call 粒度拆分；② 成本核算；③ 把 usage 暴露到事件流。故 P2-3 **不再是 P0-1/P1-3 的阻塞前置**。
- **改动**：kernel 聚合各 turn provider usage 到 `RunResult.usage`；可选定价表算成本。
- **验收**：多 turn 跑完，断言累计 input/output tokens 正确。
- **工作量**：S ｜ **依赖**：被 P0-1、P1-3 依赖，建议提前做。

### P2-4 权限网关表达力（defer + 改写入参）
- **缺口**：网关只 allow/ask/deny，不能 defer 决策、不能改写工具入参。Claude Code PreToolUse 可返回 `permissionDecision`(含 defer) + `updatedInput`。
- **改动**：`Decision` 增 `defer`；gate 支持返回 `updatedInput` 改写 `ctx.call.input` 后再执行。
- **验收**：策略返回改写后的入参→断言工具收到改写值；defer→交下一层决策。
- **工作量**：S ｜ **依赖**：无。
- 注：调研中「Claude Code 有 31 个 hook 事件 vs 你 5 个」的说法被对抗验证 **0-3 推翻**（夸大计数）。真实差距仅是**网关表达力 + 少数生命周期粒度**（如 `UserPromptSubmit`/`PreCompact` 等价物），不是缺扩展性。按需补，不紧急。

---

## P3 — 设计 non-goal / 低频（按需再议）

### P3-1 检索 / RAG / 长期记忆
- 设计 spec 已明确列为 non-goal。若要做，建议作为**独立上层包**（embeddings + vector + retriever tool），不进核心。工作量 L。

### P3-2 更多 Provider（Gemini / Bedrock / Vertex / 原生 Ollama 预设）
- 现仅 Anthropic + OpenAI（兼容端点可跑本地）。多数需求已被 OpenAI-compatible 覆盖；按真实诉求再加。工作量 S-M/个。

---

## 建议执行顺序（DAG）

```
先做底座:  P2-3 usage 计量 (S)
           │
P0 波次:   P0-1 Compactor ─┐   P0-2 Store/resume    P0-3 retry
                           │        │
P1 波次:   P1-3 OTel ◄─────┘        └──► P1-2 subagent transcript 复用
           P1-1 MCP（独立，最大价值，可与 P0 并行）
P2 波次:   P2-1 结构化输出   P2-2 本地 codec   P2-4 网关 defer/改写
```

**两周可交付的高价值组合**：P2-3 + P0-1 + P0-2 + P0-3（补齐长会话与 resume 两条 P0 红线）+ 启动 P1-1 MCP（stdio）。

---

## 需你拍板的 4 个决策（决定缺口是「架构性」还是「只是没做」）

1. **Compactor/Store** 现在推进，还是继续按 Phase 4 占位？（建议现在做，成本低）
2. **MCP** 做成一等策略/中间件，还是仅约定「用户手动包成 Tool」？（决定 P1-1 形态）
3. ~~**多 agent 编排**在不在轻量内核 scope？~~ ✅ **已定（2026-06-23）**：`core` 只提供 primitive 能力，多 agent 编排（agent-as-tool / subagent）放 **`sdk` 层**，基于 `createLiteAgent` 组合实现；`core` 不为此新增抽象。
4. **可观测性**走 adapter 映射 OTel（保持核心轻量，推荐），还是 kernel 原生 OTel？是否因 OTel GenAI 仍实验态而暂缓？

---

## 诚实标注（证据强度）

- 每条 gap 的**竞品侧**有官方一手文档支撑（Claude/OpenAI/LangGraph/OTel docs）；**本仓侧**由 2026-06-23 源码审计确认（grep + 读 kernel/strategies/middleware/permission/events）。
- 高置信（两侧均验证）：MCP、subagent、会话持久化、压缩、可观测性、权限网关。
- 中置信（本仓侧已验、竞品侧依赖通用行业认知）：结构化输出、RAG。
- 被推翻未采纳：「Claude Code 31 hooks vs 5」(0-3)、「LangGraph 多 checkpointer 后端清单」(1-2，但 thread_id resume 本身 3-0 确认)。
