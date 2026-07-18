# 严格单机装配

`@lite-agent/local` 面向本地模型（Ollama、vLLM、LM Studio、llama.cpp）运行 agent，内置 SQLite 持久化、强制 OS 沙箱、deny-by-default 权限和防篡改审计日志——全部以安全默认值装配到位。当模型和数据都不能离开这台机器、并且你希望安全姿态是被强制而非靠自觉配置时，选它。

核心理念是 **fail-closed（失败即关闭）**：每一层在安全不变量不满足时都会拒绝运行。非 loopback 端点、无法初始化的沙箱、格式错误的权限文件、缺少安全元数据的自定义工具——这些都会在启动时直接中止，而不是静默降级。

```bash
pnpm add @lite-agent/local
```

要求 macOS 或 Linux、Node ≥ 20，以及一个正在运行的本地模型服务。`better-sqlite3` 和 `@anthropic-ai/sandbox-runtime` 会作为传递性原生/运行时依赖被引入。

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

## `createLocalAgent()` 强制了什么

`createLocalAgent(config)` 构建于 SDK 的 `createLiteAgent()` 之上，但锁死了所有安全关键开关。任何会削弱安全姿态的参数都从 `LocalAgentConfig` 中整体移除——你根本无法传入。

| 层 | 保证 |
| --- | --- |
| Provider | `model.local` 必须显式声明并通过 `isLoopbackEndpoint()`（loopback IP/`localhost` 或 `unix:` socket）；启动健康探针先于一切执行。 |
| 持久化 | SQLite WAL 模式，`synchronous=FULL`，5 秒 busy timeout，每次打开时执行完整性检查。 |
| 沙箱 | `requireSandbox: true`——初始化失败即中止启动。无网络（`allowedDomains: []`），写入限定在 `workdir`，拒绝读取 `~/.ssh`、`~/.aws`、`~/.config`。 |
| 资源限制 | 每条命令都在 `ulimit` 上限下运行（默认值见下文）。 |
| 权限 | deny-by-default 的文件策略，支持热重载（下一节）。 |
| 自定义工具 | 必须声明 `security` 元数据，且 `network` 为 `"none" \| "loopback"`。 |
| 崩溃恢复 | `crashRecovery: "safe"`——被中断的工具调用在恢复会话时安全处理。 |
| 审计 | 脱敏后的事件写入轮转 SHA-256 哈希链（可选 HMAC）。 |

其他固定默认值：bash 命令 120 秒超时（后台任务 30 分钟、最多 4 个、输出上限 5 MiB）；文件修改拒绝逃逸工作区的符号链接、原子写入、每次变更前保留至多 1 MiB 快照（每会话 64 MiB），支持二进制安全恢复；超过 30 天或总量超过 1 GiB 的会话会被清理。

运行时数据存放在 SDK 项目目录下：`sessions.sqlite3` 和 `logs/events.jsonl`。

### 编解码器选择

使用 `codec: "auto"`（默认）时，仅当 provider 声明 `nativeTools: true` 才使用 native 编解码器，否则使用 JSON 编解码器。ReAct 编解码器必须显式选择：

```ts
codec: "auto" | "native" | "json" | "react" | ToolCallCodec
```

各协议的样貌见[工具调用 codec](/zh/core/codecs)。

### Token 计量

上下文预算需要 token 计数，而各本地服务差异很大：

- `vllm` 和 `llama.cpp` 预设使用服务端本地 `/tokenize` 端点（精确）。
- 任何 provider 都可以提供 `tokenEstimator`（对 SDK 而言视为精确）。
- 否则使用保守的 bytes/3 估算，并在 `diagnostics().tokenizer` 中标记为 `"approximate"`。

输入预算由声明的 `contextWindow` 推导：`contextWindow − maxTokens − 10%` 预留。如果算下来不剩空间，启动直接失败——请声明真实的上下文窗口。

## `localOpenAI()` 预设

`localOpenAI(options)` 返回一个预先打好本地能力标签的 OpenAI 兼容 provider。每个预设都知道自己的默认端点，全部可用 `baseURL` 覆盖。

| `runtime` | 默认端点 | 说明 |
| --- | --- | --- |
| `ollama` | `http://127.0.0.1:11434/v1` | |
| `vllm` | `http://127.0.0.1:8000/v1` | 通过 `/tokenize` 获得精确 token 计数 |
| `lm-studio` | `http://127.0.0.1:1234/v1` | |
| `llama.cpp` | `http://127.0.0.1:8080/v1` | 通过 `/tokenize` 获得精确 token 计数 |

选项（`LocalOpenAIOptions`）：`runtime` 和 `contextWindow`（必填），`baseURL`、`apiKey`（默认 `"local"`）、`maxRetries`、`nativeTools`（默认 `false`）、`tokenEstimator`、`probeTimeoutMs`（默认 3000）。

启动时 provider 会探测 `GET {baseURL}/models`，服务不可达即快速失败。若要使用自己构建的 provider，用 `markLocalProvider(provider, capabilities)` 打标签——同样的 loopback、`contextWindow` 和探针检查会照样生效。

## 权限

权限是 deny-by-default：开箱即用的只有只读内建工具（`read_file`、`read_spilled`、`load_skill`、`TaskGet`、`TaskList`、`BashOutput`）和交互式的 `ask_user`/`final_answer`。所有会修改状态的工具都需要显式的 `ask` 或 `allow` 规则。

### 发现顺序

规则按以下顺序从四层加载：

1. **托管层** —— `LITE_AGENT_MANAGED_PERMISSIONS` 环境变量指向的文件（或 `permissionFiles.managed`）
2. **用户层** —— `~/.lite-agent/permissions.json`（或 `permissionFiles.user`）
3. **项目层** —— `<workdir>/.lite-agent/permissions.json`（或 `permissionFiles.project`）
4. **内联层** —— 代码中的 `permissionFiles.inlineRules`

每一层都可以通过设为 `false` 禁用。**deny 永远优先**，与层的顺序无关（deny > ask > allow > 默认 `deny`），因此托管层的 `deny` 无法被项目层或内联层的 `allow` 覆盖。

文件在 mtime/size 变化时热重载；格式错误的更新会 fail-closed——重载抛错，最后的错误通过 `diagnostics().permissions.error` 暴露，并发出 `permission_reload_failed` 诊断事件。

### 文件格式

```json
{
  "version": 1,
  "rules": [
    {
      "id": "allow-tests",
      "description": "Running the test suite is fine",
      "tool": "bash",
      "when": { "command": { "startsWith": "pnpm test" } },
      "effect": "allow"
    },
    {
      "id": "ask-writes",
      "tool": ["write_file", "edit_file"],
      "effect": "ask"
    },
    {
      "id": "deny-secrets",
      "tool": "*",
      "when": { "path": { "glob": "**/.env*" } },
      "effect": "deny"
    }
  ]
}
```

- `tool` —— 名称或 glob（字符串或数组），与工具名匹配；省略则匹配所有工具。
- `when` —— 针对工具调用 `input` 内点路径（`"command"`、`"args.path"` 等）的条件；所有键都必须匹配（AND）。操作符：`regex`、`glob`、`equals`、`in`、`startsWith`、`contains`、`not`。缺失的字段不匹配任何条件——条件本身也是 fail-closed 的。
- `effect` —— `"allow" | "deny" | "ask"`（必填）。`ask` 会通过权限通道弹出询问。

## 资源限制

agent 运行的每条命令都被包裹在 `ulimit` 上限中：

| 限制 | 默认值 | `ResourceLimits` 字段 |
| --- | --- | --- |
| CPU 时间 | 120 秒 | `cpuSeconds` |
| 内存 | 2 GiB | `memoryBytes` |
| 进程数 | 128 | `maxProcesses` |

```ts
const agent = await createLocalAgent({
  // ...
  resources: { cpuSeconds: 300 }, // merged over DEFAULT_RESOURCE_LIMITS
});
```

沙箱初始化时会用 `probeResourceLimits()` 验证这些限制（要求 macOS 或 Linux 及 `/bin/bash`）；宿主机无法强制执行时启动失败。要把同样的上限应用到自己的沙箱，用 `resourceLimitedSandbox(sandbox, limits)` 包装。

:::warning 内存限制与操作系统相关
内存上限使用 `ulimit -v`，仅在 Linux 上生效。在 macOS 上 CPU 和进程数上限仍然生效，但没有硬性的内存天花板。
:::

## 自定义工具

通过 `tools` 传入的工具必须声明 `Tool.security` 元数据，且只接受离线安全的取值——其他情况都会中止启动：

```ts
import { tool } from "@lite-agent/sdk";
import { z } from "zod";

const wordCount = tool(
  "word_count",
  "Count words in a file inside the workspace",
  z.object({ path: z.string() }),
  async ({ path }) => { /* ... */ },
  { security: { network: "none", filesystem: "workspace", sideEffects: "none" } },
);

const agent = await createLocalAgent({ /* ... */, tools: [wordCount] });
```

- `security.network` 必须是 `"none"` 或 `"loopback"`——`"private"`/`"unrestricted"` 会被拒绝。
- 完全不写 `security` 也是错误：沉默被视为未知风险，而不是安全。

## 审计与诊断

### 事件汇

默认情况下，每个事件在脱敏后写入 `logs/events.jsonl`：10 MiB 轮转文件（保留 5 代），条目之间构成 SHA-256 哈希链，因此截断或篡改可以被检测。设置 `LITE_AGENT_AUDIT_KEY` 环境变量（或传入 `auditKey`）可将哈希链升级为 HMAC-SHA256。传入 `eventSink: false` 可禁用事件汇，或传入自定义的 `eventSink`/`eventRedactor`。

### 查询权限决策

每个权限判定都会作为 `permission_decision` 事件持久化。可以查询或导出：

```ts
// All denials in the current session
const denials = await agent.queryAudit({ decision: "deny" });

// Everything about a specific tool since sequence 40, in another session
const entries = await agent.queryAudit({ sessionId: "s_123", sinceSeq: 40, tool: "bash" });

// Stream the whole audit trail as NDJSON (e.g. into a file or HTTP response)
for await (const line of agent.exportAudit()) process.stdout.write(line);
```

### 诊断

`diagnostics()` 给出装配体安全姿态的快照：

```ts
const d = agent.diagnostics();
d.provider;   // { endpoint, runtime, nativeTools, contextWindow }
d.codec;      // "native" | "json" | "react" | "custom"
d.tokenizer;  // "exact" | "approximate"
d.sandbox;    // { id, required: true, hardResourceLimits: true }
d.persistence; // { file, integrity: { ok, detail } }
d.permissions; // { files, loadedAt, reloads, error? }
d.trace;      // { enabled, file?, integrity: "sha256" | "hmac-sha256" | "custom" }
```

### 关闭

`close()` 会中止所有进行中的运行，然后依次关闭事件汇、checkpointer 和沙箱。其中任何一步失败都会抛出 `AggregateError`——清理失败永远不会被吞掉。

## API 一览

| 符号 | 说明 |
| --- | --- |
| `createLocalAgent(config)` | 装配一个严格的本地 agent；返回 `LocalAgent`。 |
| `localOpenAI(options)` | 带 loopback 预设（`ollama`、`vllm`、`lm-studio`、`llama.cpp`）的 OpenAI 兼容 provider。 |
| `markLocalProvider(provider, capabilities)` | 给任意 provider 打上本地能力标签（`endpoint`、`contextWindow` 等），使其通过严格检查。 |
| `isLoopbackEndpoint(url)` | 检查端点是否为 loopback 或 Unix socket。 |
| `DEFAULT_RESOURCE_LIMITS` | 默认 `{ cpuSeconds, memoryBytes, maxProcesses }` 限制。 |
| `probeResourceLimits(limits)` | 验证宿主机能否强制执行给定限制（macOS/Linux）。 |
| `resourceLimitedSandbox(sandbox, limits)` | 包装沙箱，使命令在 `ulimit` 资源上限下运行。 |
| `LocalAgent` | `LiteAgent` 加上 `diagnostics()`、`queryAudit()`、`exportAudit()`、`close()`。 |
| 类型 | `LocalAgentConfig`、`LocalDiagnostics`、`PermissionAuditEntry`、`LocalOpenAIOptions`、`LocalProviderCapabilities`、`LocalModelProvider`、`LocalRuntime`、`ResourceLimits`。 |

## 另请参阅

- [模型提供方](/zh/core/providers)——`localOpenAI` 所基于的 `openai()` 适配器，以及如何探测兼容端点。
- [工具调用 codec](/zh/core/codecs)——`codec: "auto"` 背后的协议。
- [会话持久化](/zh/core/persistence)——本装配接入的 SQLite checkpointer。
- [权限](/zh/sdk/control/permissions)——本装配所加固的 SDK 层权限模型。
