# 可观测性

Agent 做的每件事本来就是一条带类型的 `AgentEvent` 流——文本增量、工具调用、结果、权限判定、后台任务完成。可观测性就是接住这条流：实时喂给你的 UI，和/或用 `jsonlEventSink` / `recordEventStream` 持久化成一份哈希链式 JSONL 审计日志。不需要额外的 tracing SDK。

## 记录事件流

用 `recordEventStream` 包住任意事件流，把每个事件旁路写入 `EventSink`，同时原样向下游传递：

```ts
import { query, jsonlEventSink, recordEventStream } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

const sink = jsonlEventSink({ file: "./audit/events.jsonl" });

const stream = recordEventStream(
  query({
    prompt: "Summarize package.json",
    model: anthropic(),
    modelName: "claude-sonnet-4-6",
    cwd: process.cwd(),
  }),
  sink,
  "session-1",
);

for await (const ev of stream) {
  if (ev.type === "text_delta") process.stdout.write(ev.text); // live UI output
}
await sink.close();
```

同一个循环也是驱动 UI 的方式：每个 `AgentEvent` 都有类型（`text_delta`、`tool_use`、`permission_decision`、`background_completed` 等），渲染层按 `ev.type` 分支即可。

## `jsonlEventSink`

`jsonlEventSink(opts)` 返回一个 `EventSink`，每行追加一条 JSON 记录：

```ts
export interface EventRecord {
  v: 1;
  ts: string;              // ISO timestamp
  sessionId: string;
  seq: number;             // per-file sequence
  prevHash: string | null; // hash of the previous record
  hash: string;            // sha256, or HMAC-sha256 with integrityKey
  event: AgentEvent;       // redacted before hashing
}
```

记录构成**哈希链**——每条记录都承诺了它的前驱，被篡改或重排的日志可以被检出。写入是串行化的，默认持久（每条记录 append + `fsync`）。

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `file` | —（必填） | JSONL 日志文件路径；父目录自动创建。 |
| `maxBytes` | 10 MB | 文件将超过该大小时轮转。 |
| `maxFiles` | `5` | 保留的轮转代数（`file.1` … `file.N`）。 |
| `redactor` | `defaultRedactor` | 在哈希与落盘前掩码事件中的密钥。 |
| `integrityKey` | — | 用 HMAC-sha256 替代普通 sha256 计算记录哈希的密钥。 |
| `durable` | `true` | `false` 跳过每条记录的 `fsync`（更快，抗崩溃能力更弱）。 |

相关类型：`EventSink`（`write(sessionId, event)` / `close()`）、`EventRecord`、`JsonlEventSinkOptions`。

## 权限审计事件

打开 `permissionAudit: true` 后，闸门会为每个决定向**会话事件日志**追加一条脱敏的 `permission_decision` 事件——包括决策者（`policy` / `user` / `auto`）。由于审计轨迹就在同一条事件流里，`recordEventStream` 会把它和其他事件一起捕获；配合 `permissionMode: "dry-run"` 可以记录候选策略*将会*拒绝什么而不实际拦截。见[权限](/zh/sdk/control/permissions)。

## 另请参阅

- [权限](/zh/sdk/control/permissions) — `permissionAudit`、dry-run 与脱敏。
- [检查点](/zh/sdk/control/checkpointing) — 会话事件日志本身。
- [后台任务](/zh/sdk/control/background) — `background_completed` 事件。
- [Core 策略](/zh/core/strategies) — `AgentEvent` 类型的来源。
