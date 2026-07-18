# @lite-agent/sandbox-anthropic

面向 [`@lite-agent/core`](/zh/packages/core) 的 OS 级 `Sandbox` 适配器，底层基于 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)。它把 agent 执行的 shell 命令关进 OS 边界——macOS **Seatbelt** 或 Linux **bubblewrap**——并限制文件系统与网络访问。

## 安装

```bash
pnpm add @lite-agent/sandbox-anthropic
```

## 快速开始

通过 `sandbox` 选项把沙箱传给 `createLiteAgent` / `query`：

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { sandboxRuntime } from "@lite-agent/sandbox-anthropic";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  sandbox: sandboxRuntime({
    allowWrite: ["."],                 // writable paths (default: cwd)
    denyRead: ["~/.ssh", "~/.aws"],    // blocked reads (default shown)
    allowedDomains: ["api.github.com"],// network allow-list (default: none)
    onUnavailable: (err) => console.warn(`[sandbox] degraded to noop: ${err.message}`),
  }),
});
```

此后，agent 通过 `bash` 工具执行的每条命令都会在执行前被包裹进 OS 边界——工具与中间件无需任何改动。

## 工作原理

### `Sandbox.wrap` 语义

`Sandbox` 是 `@lite-agent/core` 的第 9 个可插拔策略。其核心操作是**纯命令字符串变换**：

```ts
wrap(command: string, opts: SandboxWrapOptions): Promise<string> | string
```

core 的 `bash` 工具在 `execSync` 之前调用 `ctx.sandbox.wrap(command, { cwd })`，然后执行**包裹后的**命令。包裹后的命令会让原命令在 OS 边界内运行，因此沙箱能管住进程实际做的一切——文件写入、网络连接、子进程（一并继承边界）。

### 底层 OS 原语

| 平台 | 机制 |
| --- | --- |
| macOS | **Seatbelt**（`sandbox-exec`） |
| Linux / WSL2 | **bubblewrap** + `socat` + `ripgrep` |
| 原生 Windows | 不支持 → 优雅降级（见下文） |

边界由 OS 对运行中的进程强制生效，与模型决定跑什么无关——再花哨的命令串也绕不过它。

## API

| 符号 | 说明 |
| --- | --- |
| `sandboxRuntime(opts)` | 创建基于 `@anthropic-ai/sandbox-runtime` 的 `Sandbox`。 |
| `SandboxRuntimeOptions` | `sandboxRuntime` 接受的选项（见下表）。 |

返回的 `Sandbox`（接口定义在 `@lite-agent/core`）暴露 `initialize()`、`wrap(command, opts)` 与 `dispose()`，由内核自动调用。初始化是惰性的——沙箱运行时（含其网络代理）在首次使用时才启动。未配置 `sandbox` 时，core 默认使用 `noopSandbox()`，命令原样执行、不做包裹。

### `SandboxRuntimeOptions`

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `allowWrite` | `["."]` | 命令可写的文件系统路径。 |
| `allowRead` | `[]` | 在被拒绝的读区域内重新放行的路径。 |
| `denyRead` | `["~/.ssh", "~/.aws"]` | 禁止读取的路径。 |
| `denyWrite` | `[]` | 额外禁止写入的路径。 |
| `allowedDomains` | `[]` | 放行的网络域名。未放行时所有出站流量均被阻断。 |
| `deniedDomains` | `[]` | 拒绝的网络域名。 |
| `allowLocalBinding` | `false` | 允许沙箱内命令绑定本地端口。 |
| `allowUnixSockets` | `[]` | 命令可访问的 Unix socket 路径。 |
| `allowAllUnixSockets` | `false` | 允许访问所有 Unix socket。 |
| `enableWeakerNestedSandbox` | `false` | 已在沙箱内运行时（如容器中）放宽隔离强度。 |
| `enableWeakerNetworkIsolation` | `false` | 在无法实现完全网络隔离的环境中放宽网络隔离。 |
| `allowAppleEvents` | `false` | 允许沙箱内命令发送 Apple Events（macOS 自动化）。 |
| `requireSandbox` | `false` | `false` → 初始化失败时降级为 noop；`true` → 抛错。 |
| `onUnavailable` | — | 降级为 noop 时调用一次。 |

:::tip
默认值刻意从严：工作目录之外不可写，`~/.ssh` 与 `~/.aws` 不可读，无任何出站网络权限。需要更多访问请显式放行。
:::

## 优雅降级

OS 沙箱并非处处可初始化——缺 bubblewrap、原生 Windows、或其他不受支持的环境。`sandboxRuntime` 在不阻断 agent 的前提下处理这些情况：

- **默认（`requireSandbox: false`）**——适配器降级为 no-op：`wrap` 原样返回命令，且 `onUnavailable(err)` **只触发一次**，便于 host 记录或上报降级状态。
- **严格（`requireSandbox: true`）**——初始化失败直接抛错。强制要求边界的 host 会快速失败，而不是静默地在无沙箱状态下运行。

```ts
sandboxRuntime({
  requireSandbox: true, // production: no boundary, no run
});
```

:::warning
降级模式意味着**没有 OS 边界**。命令仍经过权限闸门，但运行时没有任何东西兜底。凡是把沙箱当硬性要求的场景，请使用 `requireSandbox: true`。
:::

## 纵深防御：权限闸门 vs. 沙箱

lite-agent 把"这条命令该不该跑"和"跑起来能碰什么"拆成两个正交的层——两者缺一不可：

| | 权限闸门 | 沙箱 |
| --- | --- | --- |
| 回答的问题 | 命令**该不该**跑？ | 跑起来**能碰什么**？ |
| 时机 | 执行前决策 | 执行中由 OS 强制 |
| 形态 | allow / deny / ask 规则、人工审批 | 文件系统 + 网络边界 |
| 能否绕过模型选择？ | 否（基于命令串判断） | **能**（OS 强制，与模型无关） |
| 实现 | `PermissionPolicy` + `ApprovalHandler`（经 `wrapToolCall` 中间件） | `Sandbox` 策略（在 `Tool.execute` 内） |

闸门在执行前决策；沙箱兜住闸门放行的命令。只有闸门：被放行的命令仍能读 `~/.ssh`、外联。只有沙箱：危险但"在边界内"的操作不会被叫停审批。两者天然分层——闸门跑在 `wrapToolCall` 中间件里，沙箱在工具内部——无需额外编排。

```ts
createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  // Gate: pre-exec decisions
  // permission: policy({ allow: ["read_file"], ask: ["bash", "write_file"] }),
  // Boundary: runtime containment
  sandbox: sandboxRuntime({
    allowedDomains: ["api.github.com", "registry.npmjs.org"],
    denyRead: ["~/.ssh", "~/.aws"],
    denyWrite: [".env"],
  }),
});
```

在此配置下：`curl evil.com` → 域名不在白名单被拦；`cat ~/.ssh/id_rsa` → 读被拒；`rm -rf ~/project-outside` → 写越界被 OS 拒绝。这一切都不依赖模型自觉。

## 限制

- **`@anthropic-ai/sandbox-runtime` 是 Beta Research Preview**——API 可能变动，且不支持原生 Windows（WSL2 可用）。这正是适配器做成可插拔、默认降级 noop 的原因。
- **网络过滤不做 TLS 解密**——基于客户端声明的 hostname 放行，存在 domain fronting 等绕过面。放行 `github.com` 这类宽域名即开了外泄通道。威胁模型更强时需自定义 MITM 代理（超出本包范围）。
- **非目标：跑完全不可信代码**——OS 级沙箱是给可信 agent 加护栏，不是隔离恶意代码。后者应使用 microVM（E2B、microsandbox），自己实现一个 `Sandbox` 接入即可——同一接口，随时替换。

## 另请参阅

- [`@lite-agent/core`](/zh/packages/core)——`Sandbox` 策略接口与 `noopSandbox` 默认实现。
- [`@lite-agent/sdk`](/zh/packages/sdk)——接受 `sandbox` 选项的 `createLiteAgent` / `query`。
- [`@lite-agent/provider`](/zh/packages/provider)——配套使用的模型 provider。
- [快速上手](/zh/guide/getting-started)——安装并运行你的第一个 agent。
