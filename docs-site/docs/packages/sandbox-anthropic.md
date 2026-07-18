# @lite-agent/sandbox-anthropic

OS-level `Sandbox` adapter for [`@lite-agent/core`](/packages/core), backed by [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime). It confines agent-run shell commands inside an OS boundary — macOS **Seatbelt** or Linux **bubblewrap** — with restricted filesystem and network access.

## Install

```bash
pnpm add @lite-agent/sandbox-anthropic
```

## Quick start

Pass the sandbox to `createLiteAgent` / `query` via the `sandbox` option:

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

From here on, every command the agent runs through the `bash` tool is wrapped into the OS boundary before execution — no changes to tools or middleware needed.

## How it works

### `Sandbox.wrap` semantics

`Sandbox` is the 9th swappable strategy in `@lite-agent/core`. Its core operation is a **pure command-string transformation**:

```ts
wrap(command: string, opts: SandboxWrapOptions): Promise<string> | string
```

The core `bash` tool calls `ctx.sandbox.wrap(command, { cwd })` right before `execSync`, then executes the **wrapped** command. The wrapped string runs the original command inside the OS boundary, so the sandbox contains whatever the process actually does — filesystem writes, network connections, child processes (which inherit the boundary).

### The underlying OS primitives

| Platform | Mechanism |
| --- | --- |
| macOS | **Seatbelt** (`sandbox-exec`) |
| Linux / WSL2 | **bubblewrap** + `socat` + `ripgrep` |
| Native Windows | Not supported → graceful degradation (see below) |

Because the boundary is enforced by the OS on the running process, it holds regardless of what the model decided to run — it cannot be talked out of with clever command strings.

## API

| Symbol | Description |
| --- | --- |
| `sandboxRuntime(opts)` | Create a `Sandbox` backed by `@anthropic-ai/sandbox-runtime`. |
| `SandboxRuntimeOptions` | Options accepted by `sandboxRuntime` (see below). |

The returned `Sandbox` (interface defined in `@lite-agent/core`) exposes `initialize()`, `wrap(command, opts)`, and `dispose()`; the kernel calls them for you. Initialization is lazy — the sandbox runtime (including its network proxy) starts on first use. When no `sandbox` is configured, core defaults to `noopSandbox()` and commands run unwrapped.

### `SandboxRuntimeOptions`

| Option | Default | Description |
| --- | --- | --- |
| `allowWrite` | `["."]` | Filesystem paths the command may write. |
| `allowRead` | `[]` | Paths re-allowed inside a denied read region. |
| `denyRead` | `["~/.ssh", "~/.aws"]` | Paths blocked from reading. |
| `denyWrite` | `[]` | Additional paths blocked from writing. |
| `allowedDomains` | `[]` | Network domains allowed. All outbound traffic is blocked unless allowed. |
| `deniedDomains` | `[]` | Network domains denied. |
| `allowLocalBinding` | `false` | Allow sandboxed commands to bind local ports. |
| `allowUnixSockets` | `[]` | Unix socket paths the command may access. |
| `allowAllUnixSockets` | `false` | Allow access to all Unix sockets. |
| `enableWeakerNestedSandbox` | `false` | Weaken isolation when already running inside a sandbox (e.g. a container). |
| `enableWeakerNetworkIsolation` | `false` | Weaken network isolation for environments where full isolation is impossible. |
| `allowAppleEvents` | `false` | Allow Apple Events (macOS automation) from sandboxed commands. |
| `requireSandbox` | `false` | `false` → degrade to noop if init fails; `true` → throw. |
| `onUnavailable` | — | Called once when degrading to noop. |

:::tip
The defaults are deliberately safe: nothing may be written outside the working directory, `~/.ssh` and `~/.aws` are unreadable, and no outbound network access is allowed. Opt in to more access explicitly.
:::

## Graceful degradation

The OS sandbox can't initialize everywhere — missing bubblewrap, native Windows, or an otherwise unsupported environment. `sandboxRuntime` handles this without blocking the agent:

- **Default (`requireSandbox: false`)** — the adapter degrades to a no-op: `wrap` returns commands unchanged, and `onUnavailable(err)` fires **exactly once** so the host can log or surface the degraded state.
- **Strict (`requireSandbox: true`)** — initialization failure throws, so a host that mandates a boundary fails fast instead of silently running unsandboxed.

```ts
sandboxRuntime({
  requireSandbox: true, // production: no boundary, no run
});
```

:::warning
Degraded mode means **no OS boundary**. Commands still pass the permission gate, but nothing contains them at runtime. Use `requireSandbox: true` where a sandbox is a hard requirement.
:::

## Defense in depth: permission gate vs. sandbox

lite-agent separates "should this command run?" from "what can it touch once running?" — two orthogonal layers that must both exist:

| | Permission gate | Sandbox |
| --- | --- | --- |
| Question | Should this command run **at all**? | What can it touch **while running**? |
| Timing | Pre-execution decision | Enforced by the OS during execution |
| Shape | allow / deny / ask rules, human approval | Filesystem + network boundary |
| Bypasses model choice? | No (judges the command string) | **Yes** (OS-enforced, independent of the model) |
| Implementation | `PermissionPolicy` + `ApprovalHandler` (via `wrapToolCall` middleware) | `Sandbox` strategy (inside `Tool.execute`) |

The gate decides before execution; the sandbox contains whatever the gate lets through. Only a gate: an approved command can still read `~/.ssh` or phone home. Only a sandbox: dangerous-but-in-bounds operations never get stopped for approval. The two compose naturally — the gate runs in `wrapToolCall` middleware, the sandbox inside the tool — no extra orchestration needed.

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

With this setup: `curl evil.com` → blocked (domain not allow-listed); `cat ~/.ssh/id_rsa` → read denied; `rm -rf ~/project-outside` → write outside boundary, rejected by the OS. None of this relies on model cooperation.

## Limitations

- **`@anthropic-ai/sandbox-runtime` is a Beta Research Preview** — its API may change, and native Windows is unsupported (WSL2 works). That is exactly why the adapter is pluggable and degrades to noop by default.
- **Network filtering does not decrypt TLS** — it trusts the client-declared hostname, so techniques like domain fronting can bypass it. Allow-listing a broad domain (e.g. `github.com`) opens an exfiltration channel. Stronger threat models need a custom MITM proxy (out of scope here).
- **Not for fully untrusted code** — an OS-level sandbox is a guardrail for a trusted agent, not isolation for malicious code. For that, use a microVM (E2B, microsandbox) behind your own `Sandbox` implementation — same interface, swappable anytime.

## See also

- [`@lite-agent/core`](/packages/core) — the `Sandbox` strategy interface and the `noopSandbox` default.
- [`@lite-agent/sdk`](/packages/sdk) — `createLiteAgent` / `query`, which accept the `sandbox` option.
- [`@lite-agent/provider`](/packages/provider) — model providers to pair with.
- [Getting started](/guide/getting-started) — install and run your first agent.
