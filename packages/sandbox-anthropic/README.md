# @lite-agent/sandbox-anthropic

**English** | [简体中文](./README.zh-CN.md)

An OS-level `Sandbox` adapter for [`@lite-agent/core`](../core), backed by [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) (macOS **Seatbelt** / Linux **bubblewrap**).

A `Sandbox` rewrites a shell command so it runs inside an OS boundary with restricted filesystem and network access. The core `bash` tool wraps its command through `ctx.sandbox` before executing — so combined with the permission gate (a pre-exec decision) you get defense-in-depth: the sandbox contains what the gate lets through.

## Install

```bash
pnpm add @lite-agent/sandbox-anthropic
```

## Usage

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

## Graceful degradation

If the OS sandbox can't initialize (no bubblewrap, native Windows, unsupported env), `sandboxRuntime` **degrades to a no-op** — commands run unwrapped and `onUnavailable(err)` fires once. Set `requireSandbox: true` to throw instead of degrading.

## Options

`sandboxRuntime(opts)` → `Sandbox`:

| Option | Default | Description |
| --- | --- | --- |
| `allowWrite` | `["."]` | Filesystem paths the command may write. |
| `allowRead` | `[]` | Paths re-allowed inside a denied read region. |
| `denyRead` | `["~/.ssh", "~/.aws"]` | Paths blocked from reading. |
| `denyWrite` | `[]` | Additional paths blocked from writing. |
| `allowedDomains` | `[]` | Network domains allowed. |
| `deniedDomains` | `[]` | Network domains denied. |
| `allowLocalBinding` | `false` | Allow sandboxed commands to bind local ports. |
| `requireSandbox` | `false` | `false` → degrade to noop if init fails; `true` → throw. |
| `onUnavailable` | — | Called once when degrading to noop. |

For no boundary at all, core ships `noopSandbox()` (the default when no `sandbox` is set).

See the [monorepo root](../..) for architecture.
