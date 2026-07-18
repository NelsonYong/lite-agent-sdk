# @lite-agent/local

Strict single-host assembly for lite-agent: run agents against local models (Ollama, vLLM, LM Studio, llama.cpp) with SQLite persistence, mandatory OS sandboxing, deny-by-default permissions, and a tamper-evident audit log — all wired together with safe defaults.

The guiding principle is **fail-closed**: every layer refuses to run unless its safety invariant holds. A non-loopback endpoint, a sandbox that cannot initialize, a malformed permission file, or a custom tool without security metadata all abort startup instead of degrading silently.

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

## What `createLocalAgent()` enforces

`createLocalAgent(config)` builds on [`createLiteAgent()`](/packages/sdk) but locks every safety-critical knob. Knobs that would weaken the posture are omitted from `LocalAgentConfig` entirely — you cannot pass them.

| Layer | Guarantee |
| --- | --- |
| Provider | `model.local` must be declared and pass `isLoopbackEndpoint()` (loopback IP/`localhost` or `unix:` socket); a startup health probe runs before anything else. |
| Persistence | SQLite in WAL mode with `synchronous=FULL`, 5 s busy timeout, and an integrity check on every open. |
| Sandbox | `requireSandbox: true` — initialization failure aborts startup. No network (`allowedDomains: []`), writes confined to `workdir`, reads denied for `~/.ssh`, `~/.aws`, `~/.config`. |
| Resource limits | Every command runs under `ulimit` caps (defaults below). |
| Permissions | Deny-by-default file policy with hot reload (next section). |
| Custom tools | Each must declare `security` metadata with `network: "none" \| "loopback"`. |
| Crash recovery | `crashRecovery: "safe"` — interrupted tool calls are recovered safely on resume. |
| Audit | Redacted events to a rotating SHA-256 hash chain (optional HMAC). |

Additional fixed defaults: bash commands time out at 120 s (30 min for background tasks, at most 4 of them, 5 MiB max output); file mutations reject symlinks escaping the workspace, write atomically, and snapshot up to 1 MiB per change (64 MiB per session) for binary-safe restore; sessions older than 30 days or beyond 1 GiB total are cleaned up.

Runtime data lives under the SDK project directory: `sessions.sqlite3` and `logs/events.jsonl`.

### Codec selection

With `codec: "auto"` (the default), the native codec is used only when the provider declares `nativeTools: true`; otherwise the JSON codec is used. The ReAct codec must be selected explicitly:

```ts
codec: "auto" | "native" | "json" | "react" | ToolCallCodec
```

### Token accounting

Context budgeting needs token counts, and local servers differ wildly here:

- `vllm` and `llama.cpp` presets use the server's local `/tokenize` endpoint (exact).
- Any provider may supply `tokenEstimator` (exact, as far as the SDK is concerned).
- Otherwise a conservative bytes/3 estimate is used and flagged as `"approximate"` in `diagnostics().tokenizer`.

The input budget is derived from the declared `contextWindow`: `contextWindow − maxTokens − 10%` reserve. If that leaves nothing, startup fails — declare the real context window.

## `localOpenAI()` presets

`localOpenAI(options)` returns an OpenAI-compatible provider pre-tagged with local capabilities. Each preset knows its default endpoint; all can be overridden with `baseURL`.

| `runtime` | Default endpoint | Notes |
| --- | --- | --- |
| `ollama` | `http://127.0.0.1:11434/v1` | |
| `vllm` | `http://127.0.0.1:8000/v1` | exact token counts via `/tokenize` |
| `lm-studio` | `http://127.0.0.1:1234/v1` | |
| `llama.cpp` | `http://127.0.0.1:8080/v1` | exact token counts via `/tokenize` |

Options (`LocalOpenAIOptions`): `runtime` and `contextWindow` (required), `baseURL`, `apiKey` (defaults to `"local"`), `maxRetries`, `nativeTools` (default `false`), `tokenEstimator`, `probeTimeoutMs` (default 3000).

At startup the provider probes `GET {baseURL}/models` and fails fast if the server is unreachable. To use a provider you built yourself, tag it with `markLocalProvider(provider, capabilities)` — the same loopback, `contextWindow`, and probe checks then apply.

## Permissions

Permissions are deny-by-default: only the read-only built-ins (`read_file`, `read_spilled`, `load_skill`, `TaskGet`, `TaskList`, `BashOutput`) and the interactive `ask_user`/`final_answer` tools are allowed out of the box. Every mutating tool needs an explicit `ask` or `allow` rule.

### Discovery order

Rules load from four layers, in order:

1. **Managed** — the file in `LITE_AGENT_MANAGED_PERMISSIONS` (or `permissionFiles.managed`)
2. **User** — `~/.lite-agent/permissions.json` (or `permissionFiles.user`)
3. **Project** — `<workdir>/.lite-agent/permissions.json` (or `permissionFiles.project`)
4. **Inline** — `permissionFiles.inlineRules` in code

Each layer can be disabled by setting it to `false`. **Deny always wins** regardless of layer order (deny > ask > allow > default `deny`), so a managed `deny` cannot be overridden by a project or inline `allow`.

Files are hot-reloaded when their mtime/size changes; a malformed update fails closed — the reload throws, the last error is surfaced via `diagnostics().permissions.error`, and a `permission_reload_failed` diagnostic event is emitted.

### File format

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

- `tool` — a name or glob (string or array), matched against the tool name; omit to match all tools.
- `when` — conditions on dot-paths into the tool call's `input` (`"command"`, `"args.path"`, …); all keys must match (AND). Operators: `regex`, `glob`, `equals`, `in`, `startsWith`, `contains`, `not`. A missing field matches nothing — conditions fail closed too.
- `effect` — `"allow" | "deny" | "ask"` (required). `ask` surfaces a prompt through the permission channel.

## Resource limits

Every command the agent runs is wrapped in `ulimit` caps:

| Limit | Default | `ResourceLimits` field |
| --- | --- | --- |
| CPU time | 120 s | `cpuSeconds` |
| Memory | 2 GiB | `memoryBytes` |
| Processes | 128 | `maxProcesses` |

```ts
const agent = await createLocalAgent({
  // ...
  resources: { cpuSeconds: 300 }, // merged over DEFAULT_RESOURCE_LIMITS
});
```

At sandbox initialization the limits are verified with `probeResourceLimits()` (requires macOS or Linux and `/bin/bash`); if the host cannot enforce them, startup fails. To apply the same caps to your own sandbox, wrap it with `resourceLimitedSandbox(sandbox, limits)`.

:::warning Memory enforcement is OS-dependent
The memory cap uses `ulimit -v`, which is applied on Linux only. On macOS the CPU and process caps still apply, but there is no hard memory ceiling.
:::

## Custom tools

Tools passed via `tools` must declare [`Tool.security`](/packages/core) metadata, and only offline-safe values are accepted — anything else aborts startup:

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

- `security.network` must be `"none"` or `"loopback"` — `"private"`/`"unrestricted"` are rejected.
- Omitting `security` entirely is also an error: silence is treated as unknown risk, not as safe.

## Audit and diagnostics

### Event sink

By default every event is written — after redaction — to `logs/events.jsonl`: a 10 MiB rotating file (5 generations) whose entries form a SHA-256 hash chain, so truncation or tampering is detectable. Set the `LITE_AGENT_AUDIT_KEY` env var (or pass `auditKey`) to upgrade the chain to HMAC-SHA256. Pass `eventSink: false` to disable the sink, or your own `eventSink`/`eventRedactor` to customize it.

### Querying permission decisions

Every permission verdict is persisted as a `permission_decision` event. Query or export them:

```ts
// All denials in the current session
const denials = await agent.queryAudit({ decision: "deny" });

// Everything about a specific tool since sequence 40, in another session
const entries = await agent.queryAudit({ sessionId: "s_123", sinceSeq: 40, tool: "bash" });

// Stream the whole audit trail as NDJSON (e.g. into a file or HTTP response)
for await (const line of agent.exportAudit()) process.stdout.write(line);
```

### Diagnostics

`diagnostics()` snapshots the assembly's posture:

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

### Shutdown

`close()` aborts any in-flight runs, then closes the event sink, checkpointer, and sandbox. If any of these fail, it throws an `AggregateError` — cleanup failures are never swallowed.

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

- [`@lite-agent/sdk`](/packages/sdk) — the general-purpose assembly this package hardens for single-host use.
- [`@lite-agent/core`](/packages/core) — provider-agnostic kernel (strategies, middleware, event stream).
- [`@lite-agent/provider`](/packages/provider) — model providers used by `localOpenAI`.
- [`@lite-agent/checkpoint-sqlite`](/packages/checkpoint-sqlite) — the SQLite checkpointer used here.
- [`@lite-agent/sandbox-anthropic`](/packages/sandbox-anthropic) — the OS sandbox runtime used here.
- [Getting started](/guide/getting-started) — install and run your first agent.
