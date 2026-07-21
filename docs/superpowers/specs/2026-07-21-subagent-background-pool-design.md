# 同级子代理后台任务池设计

**日期：** 2026-07-21  
**状态：** 已实施

## 1. 背景与问题

当前 SDK 已经有 session-scoped `BackgroundTasks` 和 `SessionRunner`，但
`Agent` 工具仍把一次调用中的多个子代理封装成一个局部批次：每次调用都新建
一个独立的 `p-limit(5)`。因此两个批次各派生三个子代理时，系统没有共享的
子代理容量控制，实际可以同时运行六个 child kernel。

当前派生链路还有两个状态错误：

1. `runOne()` 将 child 异常转换成普通字符串并正常返回，导致整个后台批次的
   Promise fulfilled，`BackgroundCompletion.isError` 被错误设置为 `false`。
2. `createLiteAgent` 的 `Spawn` 合约只返回 `Promise<string>`，丢弃 child
   `RunResult.stopReason`。`max_turns`、`aborted` 或空的最终文本因此可能被显示为
   成功完成。

名称方面，`subagent_type` 同时承担定义查找和展示职责；已有的
`tasks[].description` 没有被使用，导致多个 `general-purpose` 运行无法区分。

## 2. 目标

- 所有长期会话中的 `Agent` 派发都立即返回，不等待任何 child kernel。
- 在一个根 `LiteAgent` 实例内建立共享的子代理任务池，统一限制并发并支持排队。
- 一个 `Agent` 调用是一个同级任务组；组内所有子代理结束后只产生一次聚合完成通知。
- 组内混合结果明确标记为 `partial`，绝不把失败组标记为成功。
- 每个任务必须由调用方提供 `display_name`，并在事件、聚合结果和 UI 中可区分。
- 保留 `subagent_type` 作为稳定的定义/角色标识，保留 `agentId` 作为可恢复运行身份。
- 保留当前 session runner 的串行 transcript 写入、自动唤醒、订阅和关闭语义。
- 保留一次性 `query()` 的有限生命周期，关闭前收拢它创建的子代理组，不遗留悬挂任务。

## 3. 非目标

- 本次不实现子代理递归派生；child 仍然使用 `agents: false`。
- 本次不实现 Claude Code Agent Teams 的消息总线、自治认领、共享收件箱或计划审批。
- 不做跨进程、跨机器或进程重启后继续执行的 durable worker queue。
- 不改变 `bash` 后台命令的现有 detached 输出和 `BashOutput` 语义。
- 不把 subagent-specific 的 parent/child 字段塞入通用 `AgentEvent`；使用现有
  `agentId` 与合成的子代理 tool call 配对。

## 4. 与 Claude Code / Agent SDK 的关系

Claude 系列产品的可复用部分是边界，而不是某一个默认值：

- definition 描述代理角色和系统提示；
- invocation 描述本次任务和显示信息；
- session/task owner 负责后台生命周期、取消和完成通知；
- Agent Teams 是比普通 subagent 更高层的协作系统。

本项目沿用 definition 与 invocation 分离、隔离 child context、session-owned
后台生命周期等边界，但按本项目的 fan-out 需求把长期 `Agent` 调用统一设为后台。
同步结果只保留在一次性 `query()` 的收拢适配中。

## 5. 选定架构

```text
one LiteAgent instance
├── SessionRunner
│   └── serializes user turns and autonomous completion turns per session
├── SubagentPool
│   └── shared FIFO capacity: maxParallelSubagents
├── session-owned BackgroundTasks (one registry per session)
│   ├── group A: A1, A2, A3
│   └── group B: B1, B2, B3
└── subscribe()/close()
```

### 5.1 职责边界

`SubagentPool` 位于 SDK 层，只负责 child job 的排队、共享并发额度、组内
`allSettled` 聚合和关闭时取消排队项。它不负责 transcript 或模型回合。

`BackgroundTasks` 继续是通用的 session 生命周期原语，负责 handle、AbortSignal、
完成队列和 `onCompleted` 唤醒。一次 `Agent` 调用向 registry 注册一个组级 detached
任务；组内 child job 通过共享 pool 执行。

`SessionRunner` 继续保证同一 session 同时只有一个 core run。组完成后，runner
一次性取出该组的聚合 completion，注入一条后台完成消息并启动一个 autonomous
completion turn。用户新输入可以在组运行期间提交，按 session 顺序排队。

### 5.2 并发与排队

新增 SDK 配置 `maxParallelSubagents`，默认值为 5，与 `maxParallelTools` 和
`backgroundLimits` 分离：

- `maxParallelTools` 限制一个模型回合内的普通工具调用；
- `maxParallelSubagents` 限制一个根 `LiteAgent` 实例内正在运行的 child kernel；
- `backgroundLimits` 继续限制 session registry 中的后台组/命令句柄。

池满时任务进入 FIFO 等待队列。组级取消会移除尚未开始的 child，并 abort 已开始的
child；`close()` 会取消所有组并等待 pool 的可观察退出。

## 6. Agent tool 契约

### 6.1 输入

`Agent` 的任务项改为：

```ts
{
  display_name: string;   // required, non-empty
  subagent_type: string;  // AgentLoader definition key
  prompt: string;
  resume?: string;        // prior agentId
}
```

`run_in_background` 不再改变行为，长期会话中所有 Agent 派发均为后台。实现可以
在一个过渡版本接受并忽略该旧字段，但新生成的 tool schema 和系统提示不再鼓励模型
发送它。

### 6.2 名称与身份

- `subagent_type` 只用于 `AgentLoader.get()`、definition system prompt 和类型回退。
- `display_name` 用于合成的 child `tool_use/tool_result` 名称、聚合标题、组标签和
  日志展示；换行和控制字符必须清理。
- `agentId` 继续使用稳定、可恢复的 session id 格式；不把显示名编码为唯一身份。
- 合成 child event 的 input 同时保留 `display_name`、`subagent_type` 和 `prompt`，
  使 UI 可以在不扩大 core event union 的情况下建立映射。

### 6.3 返回值与完成粒度

工具调用只返回组级 placeholder，例如：

```text
[background:bg_xxx] accepted group with 3 subagents; results will arrive together.
```

child 的实时事件仍可经 `subscribe()` 观察，但模型可见的完成结果始终是一个组级
聚合消息，不按 child 单独唤醒模型。

## 7. 结构化结果与错误语义

### 7.1 Child result

`Spawn` 不再是 `Promise<string>`，而是保留 terminal metadata 的结果；至少包含：

```ts
type SubagentResult = {
  status: "completed" | "failed" | "cancelled";
  text?: string;
  error?: string;
  stopReason?: "stop" | "aborted" | "max_turns";
};
```

分类规则：

- child 抛出 provider/codec/runtime 异常 → `failed`；
- `stopReason: "max_turns"` → `failed`；
- `stopReason: "aborted"` 且由组取消触发 → `cancelled`；
- `stopReason: "stop"` 但没有最终文本 → `failed`，因为 subagent 合约要求返回最终答案；
- `stopReason: "stop"` 且有文本 → `completed`。

### 7.2 Group result

组状态按所有 child 结果计算：

| 子代理结果 | 组状态 |
|---|---|
| 全部 `completed` | `completed` |
| 不同 child 状态混合 | `partial` |
| 全部 `failed` | `failed` |
| 全部 `cancelled` | `cancelled` |

聚合内容必须包含每个 child 的 `display_name`、`agentId`、状态、成功文本或错误原因，
并保持输入顺序。`partial` 的成功结果不能被丢弃。

### 7.3 Core background completion

将通用 `BackgroundCompletion` 扩展为可表达生命周期状态的结构：

```ts
type BackgroundStatus = "completed" | "partial" | "failed" | "cancelled";
```

`status` 是新的权威字段；现有 `isError` 保留为兼容字段，并在状态不是
`completed` 时为 `true`。`backgroundCompletionMessage()` 在标签上输出
`status="partial|error|cancelled"`，成功完成保持无状态属性的兼容格式。

`done` 事件仍只表示某个模型回合结束，不代表后台组成功；UI 必须以
`background_completed.completion.status` 和 child `tool_result.isError` 为准。

## 8. 生命周期与一次性 query

### 8.1 `createLiteAgent`

这是后台子代理的正式入口。应用持有一个长期 Agent 实例，使用 `send()`/`run()`
处理用户回合，用 `subscribe()` 观察后台完成，用 `close()` 统一取消和清理。

### 8.2 `query`

`query()` 仍然是有限的一次性 facade。它可以提交后台组，但在自身 generator
结束前必须等待并收拢该临时 agent 创建的组，然后再执行 `close()`；因此调用方最终
仍获得完整的有限结果，也不会留下被立即取消的 child。需要“提交后立即把控制权还给
应用并在之后继续交互”的场景必须使用 `createLiteAgent()`。

## 9. 兼容性与迁移

- `Agent` schema 增加必填 `display_name`；旧调用缺少该字段时应得到明确的 schema 错误，
  不再静默使用 `general-purpose` 作为展示名。
- `subagent_type` 的 definition 查找和 `resume` 语义保持不变。
- `run_in_background` 的旧输入在过渡期可接受但不再改变长期会话行为；文档和系统提示
  将说明所有 Agent 组均为后台。
- `BackgroundCompletion.isError` 保留，新增 `status` 供新 UI 使用。
- `query()`、`createLiteAgent()` 的现有方法签名保留；新增 `maxParallelSubagents`。
- 这是 0.x 的行为和类型扩展，变更的 `core`、`sdk` 包需要更新英文 CHANGELOG；版本号
 只在实现和验证完成后按仓库 release 流程处理。

## 10. 测试策略

### Core

- `BackgroundStatus` 的成功、partial、failed、cancelled 映射和 XML notification。
- 一个 background run 返回结构化 partial 结果时，completion 保留 status 与 `isError`。
- 旧的直接 throw 任务仍生成 failed completion。

### SDK Agent tool / pool

- 两个组各三个 child 共享一个全局并发上限；不会出现每组各自开五个槽位的情况。
- 组内结果只在所有 child settle 后产生一次 completion。
- 两个成功、一个失败得到 `partial`，成功文本和失败原因全部保留。
- provider throw、codec throw、`max_turns`、abort、空最终文本均不能产生成功状态。
- 缺少 `display_name` 被拒绝；相同 `subagent_type` 的不同 display name 在事件和聚合标题中可区分。
- 组级取消能取消排队和运行中的 child；关闭 pool 不遗留任务。

### Session runner / query

- 后台组运行期间可以提交新的用户回合；完成后只启动一次后台 completion turn。
- 完成 turn 与用户 turn 不并发，completion message 持久化到所属 session。
- `query()` 在返回前收拢临时组并关闭，不丢失结果、不泄漏 child。
- `createLiteAgent.close()` 取消所有 session 的组并结束订阅。

### 全量验证

依赖包构建后依次运行：

```bash
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

## 11. 文档影响

更新 SDK 中英文 README、子代理文档、后台任务文档和系统提示，明确：

- `display_name` 是必填的本次运行名称；
- Agent 组统一后台、组级一次性送达；
- `partial` 的含义和错误查看方式；
- 长期后台场景使用 `createLiteAgent + subscribe`，一次性场景使用 `query`；
- 本次不提供递归 subagent 或 Agent Teams。
