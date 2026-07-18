# @lite-agent/sandbox-anthropic

**English** | [简体中文](./README.zh-CN.md)

OS-level `Sandbox` adapter for [`@lite-agent/core`](../core), backed by [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime). It confines agent-run shell commands inside an OS boundary — macOS **Seatbelt** or Linux **bubblewrap** — with restricted filesystem and network access.

## Install

```bash
pnpm add @lite-agent/sandbox-anthropic
```

## Quick start

Pass the sandbox to `createLiteAgent` / `query`:

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

## Features

- **OS-enforced boundary** — commands execute under Seatbelt (macOS) or bubblewrap (Linux), not application-level checks.
- **Filesystem control** — allow/deny lists for read and write paths; `~/.ssh` and `~/.aws` are denied by default.
- **Network control** — domain allow/deny lists; all outbound traffic is blocked unless allowed.
- **Defense-in-depth** — the core `bash` tool wraps every command through `ctx.sandbox` before executing, so the sandbox contains whatever the permission gate lets through.
- **Graceful degradation** — if the OS sandbox can't initialize (no bubblewrap, native Windows, unsupported env), it degrades to a no-op and fires `onUnavailable(err)` once; set `requireSandbox: true` to throw instead.
- **Zero-dependency interface** — implements the `Sandbox` strategy from `@lite-agent/core`, so any tool using `ctx.sandbox` works with it unchanged.

## API

| Symbol | Description |
| --- | --- |
| `sandboxRuntime(opts)` | Create a `Sandbox` backed by `@anthropic-ai/sandbox-runtime`. |
| `SandboxRuntimeOptions` | Options accepted by `sandboxRuntime` (see below). |

The returned `Sandbox` (interface defined in `@lite-agent/core`) exposes `initialize()`, `wrap(command)`, and `dispose()`; the kernel calls them for you. When no `sandbox` is configured, core defaults to `noopSandbox()` — commands run unwrapped.

### `SandboxRuntimeOptions`

| Option | Default | Description |
| --- | --- | --- |
| `allowWrite` | `["."]` | Filesystem paths the command may write. |
| `allowRead` | `[]` | Paths re-allowed inside a denied read region. |
| `denyRead` | `["~/.ssh", "~/.aws"]` | Paths blocked from reading. |
| `denyWrite` | `[]` | Additional paths blocked from writing. |
| `allowedDomains` | `[]` | Network domains allowed. |
| `deniedDomains` | `[]` | Network domains denied. |
| `allowLocalBinding` | `false` | Allow sandboxed commands to bind local ports. |
| `allowUnixSockets` | `[]` | Unix socket paths the command may access. |
| `allowAllUnixSockets` | `false` | Allow access to all Unix sockets. |
| `enableWeakerNestedSandbox` | `false` | Weaken isolation when already running inside a sandbox. |
| `enableWeakerNetworkIsolation` | `false` | Weaken network isolation (for environments where full isolation is impossible). |
| `allowAppleEvents` | `false` | Allow Apple Events (macOS automation) from sandboxed commands. |
| `requireSandbox` | `false` | `false` → degrade to noop if init fails; `true` → throw. |
| `onUnavailable` | — | Called once when degrading to noop. |

## Related

- [`@lite-agent/core`](../core) — the `Sandbox` strategy interface and `noopSandbox` default.
- [`@lite-agent/sdk`](../sdk) — `createLiteAgent` / `query`, which accept a `sandbox` option.
- [`@lite-agent/provider`](../provider) — model providers to pair with.
- [lite-agent monorepo](../..) — architecture and full package list.
