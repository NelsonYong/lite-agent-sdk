# @lite-agent/local

[English](./README.md) | **简体中文**

lite-agent 的严格单机组装包：面向本地模型（Ollama、vLLM、LM Studio、llama.cpp）运行 agent，内置 SQLite 持久化、强制 OS 沙箱、默认拒绝的权限体系和防篡改审计日志——全部以安全默认值预装完成。

## 安装

```bash
pnpm add @lite-agent/local
```

要求 macOS 或 Linux、Node ≥ 20，以及一个已启动的本地模型服务。`better-sqlite3` 和 `@anthropic-ai/sandbox-runtime` 会作为传递的原生/运行时依赖一并安装。

## 快速开始

```ts
import { createLocalAgent, localOpenAI } from "@lite-agent/local";

const agent = await createLocalAgent({
  model: localOpenAI({
    runtime: "ollama",
    contextWindow: 32_768,
    nativeTools: true, // set only when the selected model supports tool calling
  }),
  modelName: "qwen3:8b",
  workdir: process.cwd(),
});

const result = await agent.send("Summarize this project.");
console.log(result.text);
console.log(agent.diagnostics());
await agent.close();
```

使用默认的 `codec: "auto"` 时，仅当 `nativeTools: true` 才使用原生工具调用，否则回退到 JSON codec；ReAct codec 必须显式选择。

## 特性

- **仅允许回环地址的 provider** —— endpoint 必须是 loopback 或 Unix socket，并通过启动健康探测；`localOpenAI` 内置 `ollama`、`vllm`、`lm-studio`、`llama.cpp` 预设。
- **持久化会话** —— SQLite WAL 模式、`synchronous=FULL`、打开时完整性检查，以及中断工具调用的崩溃安全恢复。
- **强制沙箱** —— 每条 bash 命令都在 OS 沙箱内运行：禁止出网、过滤环境变量、前台 CPU/墙钟 120 秒、后台 30 分钟、后台任务最多 4 个。
- **硬资源上限** —— 默认 2 GiB 内存、128 个进程、5 MiB 命令输出；可通过 `resources` 调整，或用 `resourceLimitedSandbox` 自行组装。
- **安全的文件修改** —— 拒绝 symlink、原子替换，每次修改前持久化 UTF-8/base64 快照（二进制文件可安全恢复）。
- **默认拒绝的权限** —— 只读内置工具默认允许；修改类工具必须显式配置 `ask`/`allow` 规则。规则按托管（`LITE_AGENT_MANAGED_PERMISSIONS`）→ 用户（`~/.lite-agent/permissions.json`）→ 项目（`.lite-agent/permissions.json`）→ 内联顺序加载，deny 永远优先；文件热重载，损坏更新 fail-closed。
- **离线安全的自定义工具** —— 工具必须声明 `security` 元数据，且只接受 `network: "none" | "loopback"`。
- **防篡改审计日志** —— 事件默认脱敏，写入 10 MiB 轮转的 SHA-256 hash chain（`logs/events.jsonl`）；设置 `LITE_AGENT_AUDIT_KEY`（或 `auditKey`）可升级为 HMAC。用 `queryAudit()` 查询，用 `exportAudit()` 导出 NDJSON。
- **诚实的 token 统计** —— vLLM/llama.cpp 使用本地 `/tokenize` endpoint；其他运行时使用注入的 `tokenEstimator` 或保守的 bytes/3 估算，并在 `diagnostics()` 中标注。

运行数据位于 SDK 项目目录下：`sessions.sqlite3` 和 `logs/events.jsonl`。

## API

| 符号 | 说明 |
| --- | --- |
| `createLocalAgent(config)` | 组装一个严格本地 agent；返回 `LocalAgent`。 |
| `localOpenAI(options)` | 兼容 OpenAI 的 provider，内置 loopback 预设（`ollama`、`vllm`、`lm-studio`、`llama.cpp`）。 |
| `markLocalProvider(provider, capabilities)` | 为任意 provider 附加本地能力声明（`endpoint`、`contextWindow` 等），使其通过严格检查。 |
| `isLoopbackEndpoint(url)` | 判断 endpoint 是否为 loopback 或 Unix socket。 |
| `DEFAULT_RESOURCE_LIMITS` | 默认的 `{ cpuSeconds, memoryBytes, maxProcesses }` 资源上限。 |
| `probeResourceLimits(limits)` | 校验当前主机能否强制执行给定上限（macOS/Linux）。 |
| `resourceLimitedSandbox(sandbox, limits)` | 包装一个 sandbox，让命令在 `ulimit` 资源上限内运行。 |
| `LocalAgent` | 在 `LiteAgent` 基础上增加 `diagnostics()`、`queryAudit()`、`exportAudit()`、`close()`。 |
| 类型 | `LocalAgentConfig`、`LocalDiagnostics`、`PermissionAuditEntry`、`LocalOpenAIOptions`、`LocalProviderCapabilities`、`LocalModelProvider`、`LocalRuntime`、`ResourceLimits`。 |

## 相关

- [`@lite-agent/core`](../core) —— provider 无关的内核（策略、中间件、事件流）。
- [`@lite-agent/sdk`](../sdk) —— 通用组装包，本包在其基础上做单机加固。
- [`@lite-agent/provider`](../provider) —— `localOpenAI` 所使用的模型 provider。
- [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) —— 本包使用的 SQLite checkpointer。
- [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic) —— 本包使用的 OS 沙箱运行时。
- [Monorepo 根目录](../..) —— 完整架构说明。
