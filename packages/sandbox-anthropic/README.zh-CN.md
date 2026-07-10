# @lite-agent/sandbox-anthropic

[English](./README.md) | **简体中文**

面向 [`@lite-agent/core`](../core) 的操作系统级 `Sandbox` 适配器，底层基于 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)（macOS **Seatbelt** / Linux **bubblewrap**）。

`Sandbox` 会改写一条 shell 命令，使其在受限的文件系统与网络访问的操作系统边界内运行。core 的 `bash` 工具在执行前会把命令通过 `ctx.sandbox` 包裹 —— 因此与权限门（执行前的决策）结合，就形成纵深防御：沙箱负责「关住」权限门放行的内容。

## 安装

```bash
pnpm add @lite-agent/sandbox-anthropic
```

## 用法

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

## 优雅降级

如果操作系统沙箱无法初始化（没有 bubblewrap、原生 Windows、不受支持的环境），`sandboxRuntime` 会**降级为 no-op** —— 命令原样运行，且 `onUnavailable(err)` 触发一次。设置 `requireSandbox: true` 可让其在此时直接抛错而非降级。

## 选项

`sandboxRuntime(opts)` → `Sandbox`：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `allowWrite` | `["."]` | 命令可写的文件系统路径。 |
| `allowRead` | `[]` | 在已禁止读取的区域内重新放行的路径。 |
| `denyRead` | `["~/.ssh", "~/.aws"]` | 禁止读取的路径。 |
| `denyWrite` | `[]` | 额外禁止写入的路径。 |
| `allowedDomains` | `[]` | 允许访问的网络域名。 |
| `deniedDomains` | `[]` | 禁止访问的网络域名。 |
| `allowLocalBinding` | `false` | 是否允许沙箱命令监听本地端口。 |
| `requireSandbox` | `false` | `false` → 初始化失败时降级为 noop；`true` → 抛错。 |
| `onUnavailable` | —— | 降级为 noop 时触发一次。 |

若完全不需要边界，core 提供了 `noopSandbox()`（未设置 `sandbox` 时的默认值）。

架构说明见 [monorepo 根目录](../..)。
