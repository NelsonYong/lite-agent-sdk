# 部署组合与 local 迁移

电脑、NAS、本地模型和远端模型统一使用 `createLiteAgent()`。`@lite-agent/local` 包及其 `createLocalAgent` / `LocalAgent` 已移除，不提供兼容别名。`query()` 继续复用同一构造入口；Core 的 `createAgent()` 是底层内核接口。

## 本地模型

本地端点预设迁移到 `@lite-agent/provider` 0.10.0：

```ts
import { createLiteAgent, jsonCodec } from '@lite-agent/sdk';
import { localOpenAI } from '@lite-agent/provider';

const agent = createLiteAgent({
  workdir: process.cwd(),
  model: localOpenAI({ runtime: 'ollama', contextWindow: 32768 }),
  modelName: 'qwen3:8b',
  codec: jsonCodec(), // 不支持原生工具调用的模型使用 JSON codec
});
try {
  console.log((await agent.send('总结项目')).text);
} finally {
  await agent.close();
}
```

支持原生工具调用的模型可省略 `codec`，使用 SDK 默认 native codec。`localOpenAI` 只提供 Ollama、vLLM、LM Studio、llama.cpp 的回环 HTTP(S) 端点预设，返回标准 `ModelProvider`，不会创建 agent、发起启动探测或证明进程离线。远端服务直接使用 `openai()` / `anthropic()`。

`contextWindow` 写入标准 provider context 能力，由 SDK 的共享 ContextEngine 使用。旧的 `nativeTools`、`tokenEstimator`、`probeTimeoutMs`、`.local` 标签和 `markLocalProvider` 已移除。需要自定义 provider 时直接实现 `ModelProvider`。不再把聊天消息 JSON 的 tokenize 结果标为完整模型请求的精确 token 数。

## SQLite、沙箱和权限按需组合

```bash
pnpm add @lite-agent/sdk @lite-agent/provider @lite-agent/checkpoint-sqlite @lite-agent/sandbox-anthropic
```

下例显式保留严格命令执行和持久化配置。外部传入的数据库、沙箱由宿主拥有，因此必须在 agent 停止后关闭；构造失败也要清理。

```ts
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLiteAgent, permissionFilePolicy, resolveProjectPaths } from '@lite-agent/sdk';
import type { LiteAgent } from '@lite-agent/sdk';
import { localOpenAI } from '@lite-agent/provider';
import { sqliteCheckpointer } from '@lite-agent/checkpoint-sqlite';
import { sandboxRuntime, resourceLimitedSandbox } from '@lite-agent/sandbox-anthropic';

const workdir = process.cwd();
const paths = resolveProjectPaths({ workdir });
mkdirSync(dirname(paths.sessionsDir), { recursive: true });
const sandbox = resourceLimitedSandbox(sandboxRuntime({
  requireSandbox: true,
  allowedDomains: [],
  allowWrite: [workdir],
  denyWrite: [paths.home, join(workdir, '.lite-agent')],
  denyRead: ['~/.ssh', '~/.aws', '~/.config', paths.home, join(workdir, '.lite-agent')],
}));
let database: ReturnType<typeof sqliteCheckpointer> | undefined;
let agent: LiteAgent | undefined;
try {
  await sandbox.initialize?.();
  database = sqliteCheckpointer({
    file: join(dirname(paths.sessionsDir), 'sessions.sqlite3'),
    synchronous: 'full', integrityCheckOnOpen: true,
  });
  agent = createLiteAgent({
    workdir,
    model: localOpenAI({ runtime: 'ollama', contextWindow: 32768 }),
    modelName: 'qwen3:8b',
    checkpointer: database,
    sandbox,
    permission: permissionFilePolicy({
      workdir, home: paths.home, default: 'deny',
      baseRules: [{ tool: ['read_file', 'context', 'TaskGet', 'TaskList'], effect: 'allow' }],
    }),
    permissionAudit: true,
    mcpTransports: ['stdio'],
    crashRecovery: 'safe',
    fileTools: { symlinks: 'inside', atomicWrites: true, maxSnapshotBytes: 1024 * 1024 },
    maxSnapshotBytesPerSession: 64 * 1024 * 1024,
  });
  console.log((await agent.send('总结项目')).text);
} finally {
  // 即使 agent.close 失败，也继续清理外部资源，最后报告所有失败。
  const results = await Promise.allSettled([Promise.resolve().then(() => agent?.close())]);
  results.push(...await Promise.allSettled([
    Promise.resolve().then(() => database?.close()),
    Promise.resolve().then(() => sandbox.dispose?.()),
  ]));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed');
}
```

这不是旧 LocalAgent 的隐式安全预设。迁移时需按应用需要明确配置权限、沙箱、MCP 传输、文件快照、后台任务限制和审计。没有设置 `requireSandbox: true` 的沙箱仍可能降级；普通 `createLiteAgent()` 本身不会强制 OS 沙箱。

`resourceLimitedSandbox`、`probeResourceLimits`、`DEFAULT_RESOURCE_LIMITS` 和 `ResourceLimits` 迁移到 `@lite-agent/sandbox-anthropic` 0.9.0。包装器在执行前初始化，设置任意上限失败时不会继续执行命令。CPU 上限是进程 CPU 时间，`ulimit -u` 受操作系统/用户权限语义影响，不能作为整机作业的进程配额。Linux 使用 `ulimit -v` 限制虚拟地址空间；macOS 没有这一硬内存限制。需要 Bash RSS 监控时另外设置 SDK 的 `bash.memoryBytes`；不要将这些限制描述为模型/GPU/整个运行时的资源预算。

## 旧接口迁移

| 旧接口/行为 | 替代方式 |
| --- | --- |
| `createLocalAgent` / `LocalAgent` | `createLiteAgent` / `LiteAgent` |
| `localOpenAI`、`LocalOpenAIOptions`、`LocalRuntime` | 从 `@lite-agent/provider` 导入 |
| `markLocalProvider`、`LocalModelProvider`、`LocalProviderCapabilities` | 标准 `ModelProvider` 和可选 `context`；没有本地安全标签 |
| `codec: 'auto' / 'json' / 'react'` | 选择 native 默认值，或传入 `jsonCodec()` / `reactCodec()` |
| 旧 `contextBudget` 装配 | 使用默认 ContextEngine、provider `contextWindow` 或 `context.windowTokens` |
| `diagnostics()` | 查询具体适配器：数据库 `checkIntegrity()`、文件权限 `status()` 等 |
| `queryAudit()` / `exportAudit()` | 从持有的 checkpointer `read()` 中筛选 `permission_decision`，按需导出 |
| 自动事件日志 | 组合 `jsonlEventSink` / `recordEventStream`；完整后台/子 agent 事件通过 `subscribe` 接收，宿主负责写入错误及 flush |
| 自动资源关闭 | 先 `await agent.close()`，再关闭宿主持有的数据库、日志和沙箱 |

## 离线与扩展边界

回环地址检查只是端点分类，工具 `security` 只是声明。任意自定义 provider、JS 工具及程序 Hook 都属于可信宿主代码，命令沙箱不能替它们保证离线。完整离线部署还需要约束模型服务本身和宿主进程的出站网络。

现有 provider、checkpointer、sandbox、permission 和 middleware 接口可供社区实现；本次没有加入插件加载器、隐私脱敏或远端请求过滤。隐私能力将另行设计，不能把本地执行或日志脱敏等同于远端模型数据脱敏。
