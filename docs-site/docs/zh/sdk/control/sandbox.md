# Sandbox

Sandbox 把 agent 运行的每条 shell 命令关进一道 **OS 边界**——macOS 的 **Seatbelt** 或 Linux 的 **bubblewrap**——并限制其文件系统与网络访问。[权限闸门](/zh/sdk/control/permissions)决定命令*能不能跑*，sandbox 约束它*运行时能碰到什么*——由于边界由 OS 在运行进程上强制执行，无论模型决定跑什么它都成立，无法用巧妙的命令字符串绕过。这是纵深防御中独立的第二层。

适配器是 [`@lite-agent/sandbox-anthropic`](https://github.com/anthropics/sandbox-runtime)，底层基于 `@anthropic-ai/sandbox-runtime`。

## 开启

```bash
pnpm add @lite-agent/sandbox-anthropic
```

通过 `sandbox` 选项把 `sandboxRuntime()` 传给 `createLiteAgent` / `query`：

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

从此 agent 通过 `bash` 工具运行的每条命令都会在执行前被包进 OS 边界——工具和中间件都不需要改动。

## 工作原理

`Sandbox` 是 `@lite-agent/core` 中可替换的策略之一。它的核心操作是一次**纯命令字符串变换**：

```ts
wrap(command: string, opts: SandboxWrapOptions): Promise<string> | string
```

核心的 `bash` 工具在执行前调用 `ctx.sandbox.wrap(command, { cwd })`，然后执行**包裹后的**命令。包裹后的字符串会在 OS 边界内运行原命令，因此 sandbox 能管住进程实际做的一切——文件写入、网络连接、子进程（继承边界）。

| 平台 | 机制 |
| --- | --- |
| macOS | **Seatbelt**（`sandbox-exec`） |
| Linux / WSL2 | **bubblewrap** + `socat` + `ripgrep` |
| 原生 Windows | 不支持 → 优雅降级（见下文） |

返回的 `Sandbox` 暴露 `initialize()`、`wrap(command, opts)` 和 `dispose()`，由内核负责调用。初始化是惰性的——sandbox 运行时（含网络代理）在首次使用时才启动。未配置 `sandbox` 时，core 默认使用 `noopSandbox()`，命令原样执行。

## 选项

`sandboxRuntime(opts)` 接受 `SandboxRuntimeOptions`：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `allowWrite` | `["."]` | 命令可写的文件系统路径。 |
| `allowRead` | `[]` | 在拒绝读区域内重新放行读的路径。 |
| `denyRead` | `["~/.ssh", "~/.aws"]` | 禁止读取的路径。 |
| `denyWrite` | `[]` | 额外禁止写入的路径。 |
| `allowedDomains` | `[]` | 放行的网络域名。未放行时禁止一切出站流量。 |
| `deniedDomains` | `[]` | 拒绝的网络域名。 |
| `allowLocalBinding` | `false` | 允许 sandbox 内命令绑定本地端口。 |
| `allowUnixSockets` | `[]` | 命令可访问的 Unix socket 路径。 |
| `allowAllUnixSockets` | `false` | 允许访问所有 Unix socket。 |
| `enableWeakerNestedSandbox` | `false` | 已在 sandbox 内运行（如容器中）时降低隔离强度。 |
| `enableWeakerNetworkIsolation` | `false` | 在无法实现完全隔离的环境中降低网络隔离强度。 |
| `allowAppleEvents` | `false` | 允许 sandbox 内命令发送 Apple Events（macOS 自动化）。 |
| `requireSandbox` | `false` | `false` → 初始化失败时降级为 noop；`true` → 抛错。 |
| `onUnavailable` | — | 降级为 noop 时调用一次。 |

:::tip
默认值是刻意保守的：工作目录之外不可写，`~/.ssh` 和 `~/.aws` 不可读，不允许任何出站网络。更多访问请显式开启。
:::

## 优雅降级

OS sandbox 并非处处可初始化——缺 bubblewrap、原生 Windows、或其他不受支持的环境。`sandboxRuntime` 在不阻塞 agent 的前提下处理这种情况：

- **默认（`requireSandbox: false`）** —— 适配器降级为空操作：`wrap` 原样返回命令，`onUnavailable(err)` **恰好触发一次**，便于宿主记录或提示降级状态。
- **严格（`requireSandbox: true`）** —— 初始化失败直接抛错，强制要求边界的宿主快速失败，而不是静默地裸奔。

```ts
sandboxRuntime({
  requireSandbox: true, // production: no boundary, no run
});
```

:::warning
降级模式意味着**没有 OS 边界**。命令仍经过权限闸门，但运行时没有任何东西约束它们。在 sandbox 是硬性要求的场景使用 `requireSandbox: true`。
:::

## 纵深防御：权限闸门 vs. sandbox

lite-agent 把"这条命令该不该跑？"和"跑起来后能碰到什么？"分开——两个正交的层，缺一不可：

| | 权限闸门 | Sandbox |
| --- | --- | --- |
| 问题 | 这条命令**到底能不能**跑？ | 运行时**能碰到什么**？ |
| 时机 | 执行前决策 | 执行期间由 OS 强制 |
| 形态 | allow / deny / ask 规则、人工审批 | 文件系统 + 网络边界 |
| 能否绕过模型选择？ | 否（评判命令字符串） | **能**（OS 强制，与模型无关） |
| 实现 | `PermissionPolicy` + `ApprovalHandler`（经 `wrapToolCall` 中间件） | `Sandbox` 策略（在 `Tool.execute` 内） |

闸门在执行前决策；sandbox 约束闸门放行的一切。只有闸门：被批准的命令仍能读 `~/.ssh` 或向外传数据。只有 sandbox：危险但未越界的操作永远等不到审批。两者天然组合——无需额外编排。

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

在这套配置下：`curl evil.com` → 被拦（域名未放行）；`cat ~/.ssh/id_rsa` → 拒绝读取；`rm -rf ~/project-outside` → 写在边界外，被 OS 拒绝。这些都不依赖模型配合。

## 限制

- **`@anthropic-ai/sandbox-runtime` 是 Beta Research Preview** —— API 可能变化，且不支持原生 Windows（WSL2 可用）。这正是适配器做成可插拔、默认优雅降级的原因。
- **网络过滤不解密 TLS** —— 它信任客户端声明的主机名，域名前置（domain fronting）等技术可以绕过。放行过宽的域名（如 `github.com`）会打开数据外泄通道。更强的威胁模型需要自建 MITM 代理（超出本文范围）。
- **不适用于完全不可信的代码** —— OS 级 sandbox 是给可信 agent 的护栏，不是隔离恶意代码的手段。后者请用 microVM（E2B、microsandbox）配合你自己的 `Sandbox` 实现——同一接口，随时可换。

## 另请参阅

- [权限](/zh/sdk/control/permissions) — 与 sandbox 组合的执行前闸门。
- [Core 策略](/zh/core/strategies) — `Sandbox` 策略接口与 `noopSandbox` 默认值。
- [Providers](/zh/core/providers) — 可搭配的模型 provider。
