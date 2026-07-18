# @lite-agent/sandbox-anthropic

[English](./README.md) | **简体中文**

面向 [`@lite-agent/core`](../core) 的操作系统级 `Sandbox` 适配器，底层基于 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)。它把 agent 运行的 shell 命令限制在操作系统边界内 —— macOS **Seatbelt** 或 Linux **bubblewrap** —— 并施加文件系统与网络访问限制。

## 安装

```bash
pnpm add @lite-agent/sandbox-anthropic
```

## 快速开始

把沙箱传给 `createLiteAgent` / `query`：

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";
import { sandboxRuntime } from "@lite-agent/sandbox-anthropic";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  sandbox: sandboxRuntime({
    allowWrite: ["."],                 // 可写路径（默认：cwd）
    denyRead: ["~/.ssh", "~/.aws"],    // 禁止读取的路径（默认如所示）
    allowedDomains: ["api.github.com"],// 网络白名单（默认：空）
    onUnavailable: (err) => console.warn(`[sandbox] 已降级为 noop：${err.message}`),
  }),
});
```

## 特性

- **操作系统级强制边界** —— 命令在 Seatbelt（macOS）或 bubblewrap（Linux）下执行，而非应用层检查。
- **文件系统控制** —— 读写路径的允许/禁止列表；默认禁止读取 `~/.ssh` 与 `~/.aws`。
- **网络控制** —— 域名的允许/禁止列表；未放行的出站流量一律阻断。
- **纵深防御** —— core 的 `bash` 工具在执行前会把每条命令通过 `ctx.sandbox` 包裹，沙箱负责「关住」权限门放行的内容。
- **优雅降级** —— 操作系统沙箱无法初始化时（没有 bubblewrap、原生 Windows、不受支持的环境）降级为 no-op，且 `onUnavailable(err)` 触发一次；设置 `requireSandbox: true` 可改为直接抛错。
- **零依赖接口** —— 实现 `@lite-agent/core` 的 `Sandbox` 策略接口，任何使用 `ctx.sandbox` 的工具无需改动即可配合工作。

## API

| 符号 | 说明 |
| --- | --- |
| `sandboxRuntime(opts)` | 创建基于 `@anthropic-ai/sandbox-runtime` 的 `Sandbox`。 |
| `SandboxRuntimeOptions` | `sandboxRuntime` 接受的选项（见下表）。 |

返回的 `Sandbox`（接口定义在 `@lite-agent/core`）暴露 `initialize()`、`wrap(command)` 与 `dispose()`；这些方法由内核自动调用。未配置 `sandbox` 时，core 默认使用 `noopSandbox()` —— 命令原样运行、不做包裹。

### `SandboxRuntimeOptions`

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `allowWrite` | `["."]` | 命令可写的文件系统路径。 |
| `allowRead` | `[]` | 在已禁止读取的区域内重新放行的路径。 |
| `denyRead` | `["~/.ssh", "~/.aws"]` | 禁止读取的路径。 |
| `denyWrite` | `[]` | 额外禁止写入的路径。 |
| `allowedDomains` | `[]` | 允许访问的网络域名。 |
| `deniedDomains` | `[]` | 禁止访问的网络域名。 |
| `allowLocalBinding` | `false` | 是否允许沙箱命令监听本地端口。 |
| `allowUnixSockets` | `[]` | 命令可访问的 Unix socket 路径。 |
| `allowAllUnixSockets` | `false` | 是否允许访问所有 Unix socket。 |
| `enableWeakerNestedSandbox` | `false` | 已在沙箱内运行时弱化隔离。 |
| `enableWeakerNetworkIsolation` | `false` | 弱化网络隔离（用于无法实现完整隔离的环境）。 |
| `allowAppleEvents` | `false` | 是否允许沙箱命令发送 Apple Events（macOS 自动化）。 |
| `requireSandbox` | `false` | `false` → 初始化失败时降级为 noop；`true` → 抛错。 |
| `onUnavailable` | —— | 降级为 noop 时触发一次。 |

## 相关链接

- [`@lite-agent/core`](../core) —— `Sandbox` 策略接口与 `noopSandbox` 默认实现。
- [`@lite-agent/sdk`](../sdk) —— 接受 `sandbox` 选项的 `createLiteAgent` / `query`。
- [`@lite-agent/provider`](../provider) —— 可搭配使用的模型 provider。
- [lite-agent monorepo](../..) —— 架构说明与完整包列表。
