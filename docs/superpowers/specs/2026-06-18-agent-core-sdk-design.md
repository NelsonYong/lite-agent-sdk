# Agent Core SDK —— 设计文档

- 日期:2026-06-18
- 状态:已评审,待实现计划
- 背景:把当前 `lite-agent`(demo)重构为一个**生产级、可复用、可拔插的 agent core SDK**,对标 Claude Agent SDK 与 LangChain v1 `create-agent`。

---

## 1. 目标与非目标

### 目标
- **公开可复用库**:`createAgent({...})` 风格,公共 API / 插件边界按可发布的公开库标准设计、有版本管理与文档。
- **可拔插**:换部件、加横切、做观察三类扩展点清晰且互不串味。
- **轻量**:内核极小、零三方运行时依赖(仅 `zod`);provider 单独成包,按需安装。
- **能跑本地小模型**:模型供应商与「工具调用编码」解耦,弱模型靠可插拔 codec 适配。
- **人工审批 + 白名单**:统一权限引擎(allow/deny/ask),审批为进程内「中断 → 人作答 → 恢复」。
- **ask_user**:模型可主动向人提问(自由文本 / 结构化选项),与审批对称。
- **上下文压缩**:micro + auto 两段式,作为可替换策略 + 内置中间件。
- **良好设计模式**:Strategy / Adapter / Decorator(Chain)/ Observer / Factory / Registry / Command 各归其位。

### 非目标(v1 明确不做,防 scope 蔓延)
- 持久化挂起 / 跨进程恢复审批(checkpointer)——审批只做进程内中断-恢复。
- 多智能体编排进核心——agent team 是上层独立 package。
- 分布式消息总线 / 队列。
- 内置 RAG / 向量库。
- 自动 prompt 优化 / eval 框架。
- 浏览器 / 边缘运行时——v1 锁 **Node ≥ 20、ESM、TypeScript**。

---

## 2. 设计基线(已锁定决策)

| 维度 | 决策 |
|---|---|
| 交付形态 | 公开可复用 SDK,`createAgent({...})`,公共 API/插件边界按公开库标准 |
| 模型层 | `ModelProvider` 抽象(Anthropic + OpenAI 兼容)+ **可插拔工具调用 codec**(native → JSON/ReAct 回退) |
| 权限 | 统一 `PermissionPolicy`(allow/deny/ask),白/黑名单是规则;`ask` → 进程内异步审批 |
| 审批模型 | 进程内「中断 → 人批 → 恢复」,**不做持久化挂起 / checkpoint** |
| 输出模型 | **流式 + 事件驱动**(async generator of events),顶层薄封装 `send()` |
| ask_user | 内置工具 + `InputHandler` 策略,与审批对称;未配处理器则不注册该工具 |
| 范围 | **精瘦核心**;team/worktree/background/monitor/skills 全部降为插件/示例 |
| 扩展模型 | **混合内核**:策略接口 + 中间件管道 + 类型化事件流 |

---

## 3. 架构总览

### 分层

```
┌──────────────────────────────────────────────────────────────┐
│  Host 应用 (CLI / web / 你的产品)                              │
│    createAgent({...})  ──►  for await (ev of agent.run(input)) │
└────────────────────────────┬─────────────────────────────────┘
                             │  类型化事件流 (Observer)
┌────────────────────────────▼─────────────────────────────────┐
│  AgentKernel  (极小、不可变、provider 无关的循环)              │
│   一个 turn: 组请求 → 调模型 → 解码 tool calls → 执行 → 回灌  │
└───┬────────────────┬───────────────────┬─────────────────────┘
    │ wraps          │ resolves (DI)      │ emits
┌───▼──────────┐ ┌───▼──────────────┐ ┌──▼──────────────────────┐
│ Middleware   │ │ Strategies(策略) │ │ Events(事件)            │
│ 管道         │ │  ModelProvider   │ │  text_delta             │
│ (Decorator/  │ │  ToolCallCodec   │ │  tool_use / tool_result │
│  Chain)      │ │  Tool 注册表     │ │  approval_request       │
│  permission  │ │  Compactor       │ │  input_request          │
│  compaction  │ │  PermissionPolicy│ │  compaction             │
│  retry/log   │ │  Approval/Input  │ │  turn_start / turn_end  │
│  …你自己的   │ │  Store/Session   │ │  error / done           │
└──────────────┘ └──────────────────┘ └─────────────────────────┘
```

### 包布局(pnpm monorepo)

```
packages/
  core/               # @x/agent —— kernel + 接口 + 事件类型 + createAgent + 内置中间件
                      #   依赖: 仅 zod (工具入参 schema & 类型推导)
                      #   src/{kernel, events, types, middleware, strategies(接口), builtins(permission/compaction/retry), tools(ask_user/subagent)}
  provider-anthropic/ # @x/agent-anthropic  (Adapter → @anthropic-ai/sdk)
  provider-openai/    # @x/agent-openai     (Adapter → 覆盖 vLLM/Ollama/LM Studio/llama.cpp)
examples/
  cli/                # 交互式 CLI + cliApprover + cliAsker
  team/ worktree/ monitor/ skills/   # demo 老功能重写为插件 → 反证可拔插
```

> 关键:**provider 单独成包**——只用本地 OpenAI 兼容模型的人不会被强行装上 `@anthropic-ai/sdk`。这是「轻量 + 公开库」的依赖隔离要点。

### 设计模式映射

| 模式 | 落点 |
|---|---|
| **Strategy** | 可替换部件:ModelProvider / ToolCallCodec / Compactor / PermissionPolicy / ApprovalHandler / InputHandler / Store |
| **Adapter** | 每个 ModelProvider 把厂商 API ↔ 归一化 message/tool 类型对接 |
| **Decorator / Chain-of-Responsibility** | middleware 管道(`wrapModelCall` / `wrapToolCall`) |
| **Observer** | 类型化事件流 |
| **Factory** | `createAgent()` + `openai()` / `react()` / `policy()` 等工厂函数 |
| **Registry** | Tool 注册表(name → Tool) |
| **Command** | 归一化的 `ToolCall` 对象,交给 handler 执行 |

---

## 4. 内核与事件循环

### 对外入口(两层)

```ts
interface Agent {
  // 底层:类型化事件流,可实时消费、可中断
  run(input: string | Message[], opts?: { signal?: AbortSignal; sessionId?: string }):
        AsyncGenerator<AgentEvent, RunResult>

  // 顶层:消费完整事件流后返回最终结果(便捷用法)
  send(input: string, opts?: { signal?: AbortSignal; sessionId?: string }): Promise<RunResult>
}
```

### 事件类型(单一 discriminated union)

```ts
type AgentEvent =
  | { type: 'turn_start';        turn: number }
  | { type: 'text_delta';        text: string }                       // 流式 token
  | { type: 'message';           message: AssistantMessage }          // 一条完整 assistant 消息
  | { type: 'tool_use';          call: ToolCall }                     // 已放行、即将执行
  | { type: 'approval_request';  call: ToolCall; reason?: string }    // ← 中断点(框架发起)
  | { type: 'approval_resolved'; id: string; decision: 'allow'|'deny'; by: string }
  | { type: 'input_request';     call: ToolCall; question: UserQuestion } // ← 中断点(模型发起)
  | { type: 'input_resolved';    id: string; answer: UserAnswer }
  | { type: 'tool_result';       result: ToolResult }
  | { type: 'compaction';        kind: 'micro'|'auto'; before: number; after: number }
  | { type: 'turn_end';          turn: number; stopReason: StopReason }
  | { type: 'error';             error: AgentError; fatal: boolean }
  | { type: 'done';              reason: 'stop'|'aborted'|'max_turns'; result: RunResult }
```

### 一个 turn 的生命周期(kernel 本体极小)

```
async *run(input):
  ctx = loadSession(input)
  await beforeAgent(ctx)                 # middleware (once)
  for turn in 1..maxTurns:
    yield turn_start
    await beforeModel(ctx)               # ← compaction 内置 middleware 住这,可 yield compaction
    req  = codec.encode(ctx.messages, tools)        # ToolCallCodec(策略)
    msg  = yield* provider.stream(req)   # ← wrapModelCall 链(retry)包裹; 期间 yield text_delta
    {calls, text} = codec.decode(msg)               # 归一化成 ToolCall[]
    yield message(msg)
    if calls.isEmpty: yield turn_end('stop'); break
    for call in calls:
      result = yield* toolPipeline(call) # ← wrapToolCall 链: permission→approval→execute
      ctx.append(result); yield tool_result(result)
    yield turn_end('tool_use')
  await afterAgent(ctx)
  saveSession(ctx)
  yield done(...); return result
```

kernel 不直接做权限和压缩——它们是内置中间件(见 §6)。循环本体只剩「编码 → 调模型 → 解码 → 执行 → 回灌」十几行,**所有可变行为都在中间件里**。

### 「中断-恢复」机制(审批 与 ask_user 对称)

| | approval | ask_user |
|---|---|---|
| 谁发起 | 框架(权限策略 gate) | 模型主动(它想问) |
| 问什么 | 这个工具能不能跑(yes/no) | 要信息/做决策(自由文本 / 选项) |
| 触发 | `PermissionPolicy` 判定 `ask` | 模型调用 `ask_user` 工具 |
| 共性 | **进程内 emit 请求事件 → await 处理器 Promise → 恢复**,同一事件流,无持久化 | 同左 |

1. 触发方对应 `emit(approval_request)` 或 `emit(input_request)` —— host 在事件流里看到;
2. 内部 `await handler.request(...)` —— **循环停在 await 上(中断)**;
3. host 的 CLI(读 stdin)或 web handler(等按钮)resolve(**恢复**);
4. `emit(*_resolved)`;审批 deny → 合成 `isError` 的 ToolResult 不执行。

`AbortSignal` 触发时,在途 `await` 被拒绝,生成器以 `done(reason:'aborted')` 收尾。

---

## 5. 归一化类型 + 策略接口

### 归一化类型(全 SDK 通用,provider 无关——kernel 只认这套)

```ts
type ContentBlock =
  | { type: 'text';        text: string }
  | { type: 'tool_call';   id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
type Message    = { role: 'system'|'user'|'assistant'|'tool'; content: string | ContentBlock[] }
type ToolCall   = { id: string; name: string; input: unknown }
type ToolResult = { id: string; name: string; content: string; isError?: boolean }
type UserQuestion = { question: string; options?: string[]; multiSelect?: boolean }
type UserAnswer   = { text?: string; selected?: string[] }
```

### 8 个可插拔策略契约

```ts
// 1. 模型供应商 —— 只做 Adapter:归一化请求 → 厂商 API → 归一化流式块。不懂工具语义。
interface ModelProvider {
  readonly id: string
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk>
}
type ModelChunk =
  | { type: 'text_delta';   text: string }
  | { type: 'message_done'; message: AssistantMessage; usage: Usage }

// 2. 工具调用 codec ★本地小模型核心★ —— kernel 对 native/json/react 一无所知
interface ToolCallCodec {
  encode(req: ModelRequest, tools: ToolSpec[]): ModelRequest
  decode(message: AssistantMessage): { text: string; calls: ToolCall[] }
}
//   nativeCodec()  走 provider 原生 function-calling
//   jsonCodec()    system 注入说明 + 要求输出 {"tool":..,"input":..},JSON 宽松解析
//   reactCodec()   Thought/Action/Action Input 文本协议,正则解析

// 3. 工具 —— zod schema 同时给「校验 + 类型推导 + 自动生成 JSON schema」
interface Tool<I = unknown> {
  name: string; description: string; schema: ZodType<I>
  execute(input: I, ctx: ToolContext): Promise<string> | string
}
//   ask_user / subagent 都是内置 Tool

// 4. 上下文压缩
interface Compactor {
  maybeCompact(messages: Message[], usage: Usage): Promise<CompactResult>
}
type CompactResult = { messages: Message[]; kind?: 'micro'|'auto'; before?: number; after?: number }
//   defaultCompactor() = 两段式: micro(换老 tool_result) + auto(超阈值 LLM 摘要),阈值可配

// 5. 权限策略 —— 白/黑名单是规则,glob 匹配 name(可选匹配 input)
interface PermissionPolicy { check(call: ToolCall, ctx: PolicyContext): Decision | Promise<Decision> }
type Decision = 'allow' | 'deny' | 'ask'
//   policy({ allow:['read_file'], deny:['rm *'], ask:['bash','write_file'] })

// 6. 审批处理器 —— 解析 'ask'(gate yes/no)
interface ApprovalHandler { request(call: ToolCall): Promise<'allow'|'deny'> }   // cliApprover() 内置

// 7. 输入处理器 —— 解析 ask_user(自由文本 / 选项)
interface InputHandler { request(q: UserQuestion): Promise<UserAnswer> }          // cliAsker() 内置

// 8. 会话存储(可选持久化)
interface Store {
  load(id: string): Promise<Message[] | null>
  save(id: string, messages: Message[]): Promise<void>
}
//   memoryStore()(默认) | jsonlStore(dir)(复用现有 .transcripts 思路)
```

### 本地小模型闭环
`ModelProvider` 只翻译协议、不碰工具语义;`ToolCallCodec` 负责「工具调用怎么编进请求、怎么从输出里解出来」。于是:
- 强模型(Anthropic/GPT)→ `nativeCodec` + 对应 provider;
- function-calling 不靠谱的本地 7B → **同一个 OpenAI 兼容 provider,只把 codec 换成 `jsonCodec` 或 `reactCodec`**,kernel / 工具 / 权限 / 压缩**全不动**。

---

## 6. 中间件管道

### Middleware 接口

```ts
interface Middleware {
  name: string
  beforeAgent?(ctx: AgentContext): void | Promise<void>   // 一次性:初始化/观察
  afterAgent? (ctx: AgentContext): void | Promise<void>   // 一次性:收尾/观察
  beforeModel?(ctx: AgentContext): void | Promise<void>   // 每 turn:可改写 ctx.messages(压缩住这)
  wrapModelCall?(ctx: AgentContext, next: ModelCall): AsyncIterable<ModelChunk>   // 包裹调模型(重试/缓存)
  wrapToolCall?(ctx: ToolCallContext, next: ToolExec): Promise<ToolResult>        // 包裹单次工具(权限/计时/短路)
}
type ModelCall = () => AsyncIterable<ModelChunk>
type ToolExec  = () => Promise<ToolResult>
```

### AgentContext(调策略、推事件、共享状态的唯一入口——无全局变量)

```ts
interface AgentContext {
  readonly sessionId: string
  messages: Message[]                 // 可读写(beforeModel 改写它 = 压缩)
  readonly turn: number
  readonly signal: AbortSignal
  emit(ev: AgentEvent): void          // 往事件流推(内置/自定义事件)
  state: Map<string, unknown>         // 跨 middleware 共享可变状态,避免全局
  readonly model: ModelProvider; readonly codec: ToolCallCodec
  readonly compactor: Compactor; readonly permission: PermissionPolicy
  readonly approval?: ApprovalHandler; readonly input?: InputHandler
}
interface ToolCallContext extends AgentContext { readonly call: ToolCall }
```

> `Tool.execute` 拿到的 `ToolContext` 同样带 `emit / input / approval / signal / session`,所以 `ask_user` 工具能在 execute 里 `emit(input_request)` 再 `await ctx.input.request(...)`。

### 装配顺序(数组即 外→内;内置默认最外层,可关可换位)

```ts
createAgent({
  use: [logging(), tracing(), myRateLimiter()],
  builtins: { permission: true, compaction: true, retry: true },
})
// 默认洋葱(外→内):
//   wrapModelCall : retry → (用户) → [调 provider.stream]
//   beforeModel   : compaction → (用户)
//   wrapToolCall  : permission → (用户) → [Tool.execute]
// 若用户把 permission()/compaction() 显式写进 use,则按其位置走,不再自动加(可控顺序)
```

### 内置中间件(权限/压缩本身就是中间件——自证可拔插)

```ts
// permission() : wrapToolCall
d = await ctx.permission.check(ctx.call)
if d==='allow' → return next()
if d==='deny'  → return errResult('blocked by policy')          // 不执行
if d==='ask'   → ctx.emit(approval_request)                     // ← 中断点
                 r = await ctx.approval.request(ctx.call)        // await 人
                 ctx.emit(approval_resolved)
                 return r==='allow' ? next() : errResult('denied by user')

// compaction() : beforeModel
r = await ctx.compactor.maybeCompact(ctx.messages, lastUsage)
if r.kind → ctx.messages = r.messages; ctx.emit(compaction)

// retry() : wrapModelCall —— 5xx/网络错在「未产出任何 chunk 前」重试,指数退避,响应 AbortSignal
```

### 「策略 vs 中间件 vs 事件」判定规则(团队硬约束)

| 你想做的事 | 用 | 例子 |
|---|---|---|
| **替换一个部件的实现**(同角色只有一个) | **Strategy** | 换 provider、换 codec、换压缩算法、换审批/输入 UI、换存储 |
| **给流程加一层可叠加的横切行为** | **Middleware** | 鉴权、限流、重试、缓存、计时、注入指令、改写请求/结果、条件短路 |
| **只观察、不改控制流** | **Event** | 日志、画 UI、上报指标、落 transcript |

> 口诀:**换零件 → 策略;加一层 → 中间件;只看不改 → 事件。**

---

## 7. 横切关注点

```ts
class AgentError extends Error {}
//  ProviderError(status)  ToolError  CodecError  PermissionDeniedError  MaxTurnsError  AbortError
```

- **工具出错不崩循环** → 转成 `ToolResult{isError:true}` 回灌,模型可自我纠正。
- **codec 解码失败**(小模型吐坏 JSON)→ emit `error{fatal:false}` + 回灌纠正消息「工具调用格式错误,请按 … 重发」,模型重试;`maxDecodeRetries` 可配。**本地小模型稳定性关键防线。**
- **provider 致命错** → retry 耗尽后 emit `error{fatal:true}` 并从生成器抛出(`send()` reject)。
- **取消**:`AbortSignal` 贯穿 `provider.stream` / `Tool.execute` / 审批与输入 `await`。中断 → 在途 reject → emit `done{reason:'aborted'}`,已落 messages 保留、可存盘。
- **会话/存储**:`run(input,{sessionId})` 从 `Store` load → 追加 → 结束(或每 turn)save。默认 `memoryStore()`;`jsonlStore(dir)` 落盘。让「续聊」无需持久化挂起。
- **用量**:每个 `message_done` 带 `Usage`,kernel 汇总进 `RunResult.usage`,成本统计可做成中间件。

---

## 8. 测试策略(生产级;demo 现状零测试 → 净新增,选 vitest)

| 手段 | 作用 |
|---|---|
| **`FakeProvider`** | 脚本化 assistant 响应(含 tool_call),确定性流式回放 → **整个循环零网络可测** |
| **Golden event-stream 测试** | FakeProvider + fixtures,断言**有序事件列表** → 钉死循环行为、审批/输入中断、压缩触发时机 |
| **Provider / Codec 契约测试套件** | 任何第三方 provider/codec 实现都必须通过的共享测试 → 公开库正确性保障 |
| **策略单测** | codec encode/decode 往返(含坏输入)、policy glob 匹配、compactor 阈值 |
| **中间件隔离测试** | 喂 fake ctx + next,断言短路/包裹/改写行为 |

---

## 9. Demo 老功能 → 全部落成插件(可拔插验收标准)

| 老功能 | 落成 | 机制 |
|---|---|---|
| skills | beforeAgent 注入技能描述的 middleware + `load_skill` 工具 | Middleware + Tool |
| background | `background_run/check/stop` 工具 + 完成 `emit` 事件 + 回灌结果的 beforeModel middleware | Tool + Event + Middleware |
| monitor | 纯事件流消费者 + 进程指标,起 HTTP/SSE,**零侵入** | Event only |
| worktree | git 操作工具组 | Tool |
| subagent | 内置 `subagent` 工具:execute 内 new 一个精简 `createAgent`(共享 provider/工具子集,fresh session) | Tool + 复用 kernel |
| agent team | 上层独立 package:每个 teammate 一个 `createAgent` 实例 + 自治 loop + 消息总线;**不进核心** | 组合 SDK |

**验收**:以上每一项都能只用 Tool / Middleware / Event / 组合 agent 表达,核心 kernel 不为任何一项妥协改动。

---

## 10. 包 / 运行时 / 工具链

- 运行时:Node ≥ 20,ESM-only,TypeScript(strict)。
- 核心依赖:仅 `zod`(工具 schema + 类型推导)。
- provider 包按需依赖各自厂商 SDK。
- 构建:tsup(双 d.ts + ESM 产物);Lint:eslint + typescript-eslint(补齐 demo 缺失的可用 lint)。
- 版本:changesets(公开库语义化版本 + changelog)。
- 测试:vitest。

---

## 11. 完整 `createAgent` 配置参考

```ts
const agent = createAgent({
  // ── 策略(可替换部件)──
  model: openai({ baseURL, model, apiKey }),       // | anthropic({ model, apiKey })
  codec: nativeCodec(),                            // | jsonCodec() | reactCodec()
  tools: [readFile, writeFile, bash, askUserTool(), subagentTool()],
  compactor: defaultCompactor({ microTrigger: 80_000, autoTrigger: 150_000 }),
  permission: policy({ allow: ['read_file'], ask: ['bash', 'write_file'], deny: ['rm *'] }),
  onApproval: cliApprover(),
  onAskUser:  cliAsker(),                           // 不配则不注册 ask_user 工具
  store: jsonlStore('.sessions'),                  // 默认 memoryStore()

  // ── 中间件(横切)──
  use: [logging(), tracing()],
  builtins: { permission: true, compaction: true, retry: true },

  // ── 杂项 ──
  system: '...你的系统提示...',
  maxTurns: 50,
  maxDecodeRetries: 2,
})

for await (const ev of agent.run('帮我重构配置模块')) {
  switch (ev.type) {
    case 'text_delta':       process.stdout.write(ev.text); break
    case 'approval_request': /* 已由 cliApprover 处理,这里仅观察/画 UI */ break
    case 'input_request':    /* 已由 cliAsker 处理 */ break
    case 'done':             console.log('\n', ev.result.usage); break
  }
}
```

---

## 12. 开放问题(实现阶段再定)

- `jsonCodec` / `reactCodec` 的具体提示模板与容错解析细节(需对几个目标本地模型实测调优)。
- `PermissionPolicy` 规则是否需要支持对 `input` 的匹配(如 `bash` 命令内容白名单),还是仅匹配工具名。
- 多工具并行执行(一个 turn 内多个 tool_call)是否并发——v1 倾向顺序执行以简化审批/状态;并发留作后续。
- monorepo 构建编排(turbo / 仅 pnpm scripts)在实现阶段定。
