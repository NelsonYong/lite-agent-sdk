# @lite-agent/local

**English** | [简体中文](./README.zh-CN.md)

Strict single-host assembly for lite-agent: run agents against local models (Ollama, vLLM, LM Studio, llama.cpp) with SQLite persistence, mandatory OS sandboxing, deny-by-default permissions, and a tamper-evident audit log — all wired together with safe defaults.

## Install

```bash
pnpm add @lite-agent/local
```

Requires macOS or Linux, Node ≥ 20, and a running local model server. `better-sqlite3` and `@anthropic-ai/sandbox-runtime` are pulled in as transitive native/runtime dependencies.

## Quick start

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

With `codec: "auto"` (the default), native tool calls are used only when `nativeTools: true`; otherwise the JSON codec is used. The ReAct codec must be selected explicitly.

## Features

- **Loopback-only providers** — the endpoint must be loopback or a Unix socket and pass a startup health probe; `localOpenAI` ships presets for `ollama`, `vllm`, `lm-studio`, and `llama.cpp`.
- **Durable sessions** — SQLite in WAL mode with `synchronous=FULL`, integrity check on open, and crash-safe recovery of interrupted tool calls.
- **Mandatory sandbox** — every bash command runs inside the OS sandbox: no network, filtered environment, 120 s foreground CPU/wall limit, 30 min background limit, at most 4 background tasks.
- **Hard resource limits** — 2 GiB memory, 128 processes, 5 MiB command output by default; tune via `resources` or build your own with `resourceLimitedSandbox`.
- **Safe file mutations** — symlinks rejected, atomic replacement, UTF-8/base64 snapshots persisted before every change (binary-safe restore).
- **Deny-by-default permissions** — read-only built-ins are allowed; mutating tools need an explicit `ask`/`allow` rule. Rules load from managed (`LITE_AGENT_MANAGED_PERMISSIONS`) → user (`~/.lite-agent/permissions.json`) → project (`.lite-agent/permissions.json`) → inline, deny always wins, files hot-reload and malformed updates fail closed.
- **Offline-safe custom tools** — tools must declare `security` metadata, and only `network: "none" | "loopback"` is accepted.
- **Tamper-evident audit log** — redacted events written to a 10 MiB rotating SHA-256 hash chain (`logs/events.jsonl`); set `LITE_AGENT_AUDIT_KEY` (or `auditKey`) to upgrade to HMAC. Query with `queryAudit()`, export NDJSON with `exportAudit()`.
- **Honest token accounting** — vLLM/llama.cpp use their local `/tokenize` endpoint; other runtimes use your `tokenEstimator` or a conservative bytes/3 estimate, flagged in `diagnostics()`.

Runtime data lives under the SDK project directory: `sessions.sqlite3` and `logs/events.jsonl`.

## API

| Symbol | Description |
| --- | --- |
| `createLocalAgent(config)` | Assemble a strict local agent; returns a `LocalAgent`. |
| `localOpenAI(options)` | OpenAI-compatible provider with loopback presets (`ollama`, `vllm`, `lm-studio`, `llama.cpp`). |
| `markLocalProvider(provider, capabilities)` | Tag any provider with local capabilities (`endpoint`, `contextWindow`, …) so it passes the strict checks. |
| `isLoopbackEndpoint(url)` | Check whether an endpoint is loopback or a Unix socket. |
| `DEFAULT_RESOURCE_LIMITS` | Default `{ cpuSeconds, memoryBytes, maxProcesses }` limits. |
| `probeResourceLimits(limits)` | Verify the host can enforce the given limits (macOS/Linux). |
| `resourceLimitedSandbox(sandbox, limits)` | Wrap a sandbox so commands run under `ulimit` resource caps. |
| `LocalAgent` | `LiteAgent` plus `diagnostics()`, `queryAudit()`, `exportAudit()`, `close()`. |
| Types | `LocalAgentConfig`, `LocalDiagnostics`, `PermissionAuditEntry`, `LocalOpenAIOptions`, `LocalProviderCapabilities`, `LocalModelProvider`, `LocalRuntime`, `ResourceLimits`. |

## Related

- [`@lite-agent/core`](../core) — provider-agnostic kernel (strategies, middleware, event stream).
- [`@lite-agent/sdk`](../sdk) — the general-purpose assembly this package hardens for single-host use.
- [`@lite-agent/provider`](../provider) — model providers used by `localOpenAI`.
- [`@lite-agent/checkpoint-sqlite`](../checkpoint-sqlite) — the SQLite checkpointer used here.
- [`@lite-agent/sandbox-anthropic`](../sandbox-anthropic) — the OS sandbox runtime used here.
- [Monorepo root](../..) — full architecture write-up.
