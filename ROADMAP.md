# Roadmap

## 并发 subagent + 任务归属

当前 `runSubagent` 是阻塞调用且没有身份标识——main agent 派发 subagent 后同步等待结果。`owner` 字段已从 `Task` 中删除，因为在这种模型下没有实际意义。

要让 `owner` 有价值，需要 subagent 支持：

- **唯一 ID** — 在 spawn 时分配，注入到 subagent 的上下文中
- **非阻塞派发** — main agent 并发启动多个 subagent
- **任务认领** — subagent 开始执行前调用 `task_update(id, owner=self_id, status="in_progress")`
- **轮询/完成信号** — main agent 监听 `task_list`，直到所有认领的任务变为 `completed`

架构升级后，在 `Task` 接口中恢复 `owner: string`，并在 `task_update` schema 中暴露该字段。

---

## Agent Team — 生产级改进

当前 Agent Team 为教学级实现，以下为迈向生产级的改进路线。

### P0 — 安全与正确性

- **安全沙箱** — teammate 的 `_exec` 中 `read_file` 未走 `safePath`，需统一路径校验；考虑对 `bash` 增加命令白名单或沙箱隔离
- **协议强制（状态机）** — 用状态机控制 teammate 不同阶段的可用工具集，替代纯 prompt 约束：
  - `plan_pending` 阶段：只暴露 `plan_approval` + `read_file` + `read_inbox`
  - `approved` 阶段：解锁 `bash` / `write_file` / `edit_file` 等执行工具

### P1 — 可靠性

- **消息总线** — 当前 JSONL 无锁、读即清空，崩溃丢消息；引入 ACK 机制或切换为 Redis Stream / DB-backed queue
- **错误传播** — `_teammateLoop` 的 `.catch(() => {})` 改为向 lead 上报错误；新增 teammate 状态 `error`
- **审批超时** — teammate 提交计划后 lead 未审批时，应有超时机制

### P2 — 资源管控

- **Token 预算** — 为每个 teammate 设置 token 上限，超出时暂停并通知 lead
- **超时机制** — 50 轮硬编码改为可配置；增加墙钟超时（wall-clock timeout）
- **并发控制** — 限制同时 working 的 teammate 数量，防止无限 spawn

### P3 — 可观测性

- **结构化日志** — `debug()` / `console.log` 替换为结构化日志（JSON 格式）
- **Tracing** — 接入 OpenTelemetry 或 LangSmith，按 request_id 追踪完整链路
- **Lead 感知** — teammate 结束时上报执行摘要（工具调用次数、token 消耗、耗时）

### P4 — 状态持久化

- **持久化存储** — `shutdownRequests` / `planRequests` / `_forceShutdowns` 从内存迁移到文件或 DB
- **状态扩展** — 从 3 种（`working` / `idle` / `shutdown`）扩展为：`working` / `idle` / `shutdown` / `error` / `timeout` / `plan_pending`
