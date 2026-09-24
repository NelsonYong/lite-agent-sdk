# Deployment composition and local migration

Use `createLiteAgent()` for computers, NAS deployments, local models and remote models. The `@lite-agent/local` package and its `createLocalAgent` / `LocalAgent` interfaces have been removed without compatibility aliases. `query()` delegates to the same constructor; Core's `createAgent()` remains a low-level kernel factory.

## Local models

Endpoint presets now live in `@lite-agent/provider` 0.10.0:

```ts
import { createLiteAgent, jsonCodec } from '@lite-agent/sdk';
import { localOpenAI } from '@lite-agent/provider';

const agent = createLiteAgent({
  workdir: process.cwd(),
  model: localOpenAI({ runtime: 'ollama', contextWindow: 32768 }),
  modelName: 'qwen3:8b',
  codec: jsonCodec(), // Use for models without native tool calls
});
try {
  console.log((await agent.send('Summarize this project')).text);
} finally {
  await agent.close();
}
```

Omit `codec` for models supporting native tool calls. `localOpenAI` provides loopback HTTP(S) presets for Ollama, vLLM, LM Studio and llama.cpp and returns a standard `ModelProvider`. Construction neither creates an agent nor probes the endpoint. A loopback URL does not prove offline isolation. Use `openai()` / `anthropic()` for remote services.

`contextWindow` feeds the standard provider context capability and shared SDK ContextEngine. The old `nativeTools`, `tokenEstimator`, `probeTimeoutMs`, `.local` metadata and `markLocalProvider` are removed. Implement `ModelProvider` directly for custom providers. Tokenizing JSON-serialized messages is no longer described as an exact count of the full model request.

## Compose persistence, sandbox and permissions

```bash
pnpm add @lite-agent/sdk @lite-agent/provider @lite-agent/checkpoint-sqlite @lite-agent/sandbox-anthropic
```

Hosts own externally supplied databases and sandboxes. Initialize them explicitly and close them after the agent stops, including failed-construction paths:

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
  console.log((await agent.send('Summarize this project')).text);
} finally {
  const results = await Promise.allSettled([Promise.resolve().then(() => agent?.close())]);
  results.push(...await Promise.allSettled([
    Promise.resolve().then(() => database?.close()),
    Promise.resolve().then(() => sandbox.dispose?.()),
  ]));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed');
}
```

This is explicit composition, not an implicit replacement for the former strict preset. Configure permissions, sandbox requirements, MCP transports, snapshots, background limits and audit deliberately. Sandboxes without `requireSandbox: true` may still degrade; `createLiteAgent()` does not require an OS sandbox by default.

`resourceLimitedSandbox`, `probeResourceLimits`, `DEFAULT_RESOURCE_LIMITS` and `ResourceLimits` moved to `@lite-agent/sandbox-anthropic` 0.9.0. The wrapper initializes before execution and stops if a limit cannot be set. CPU limits are process CPU time; `ulimit -u` has OS/user-specific semantics, not per-agent job quotas. Linux uses `ulimit -v` for virtual address space; macOS has no equivalent hard memory limit here. Configure SDK `bash.memoryBytes` separately for Bash RSS monitoring. These controls are not model/GPU or whole-runtime budgets.

## Migration map

| Previous interface/behavior | Replacement |
| --- | --- |
| `createLocalAgent` / `LocalAgent` | `createLiteAgent` / `LiteAgent` |
| `localOpenAI`, `LocalOpenAIOptions`, `LocalRuntime` | Import from `@lite-agent/provider` |
| `markLocalProvider`, `LocalModelProvider`, `LocalProviderCapabilities` | Standard `ModelProvider` with optional `context`; no local-safety tag |
| `codec: 'auto' / 'json' / 'react'` | Native default or `jsonCodec()` / `reactCodec()` |
| Legacy `contextBudget` assembly | Default ContextEngine, provider `contextWindow` or `context.windowTokens` |
| `diagnostics()` | Adapter-specific `checkIntegrity()`, permission `status()`, etc. |
| `queryAudit()` / `exportAudit()` | Filter `permission_decision` entries from the owned checkpointer's `read()` |
| Automatic event logging | Compose `jsonlEventSink` / `recordEventStream`; use `subscribe` for background/child events and handle write failures/flush in the host |
| Automatic resource closure | Await `agent.close()` before closing externally owned databases, logs and sandbox |

## Offline and extension boundaries

Loopback classification and `Tool.security` are declarations, not isolation guarantees. Arbitrary custom providers, JavaScript tools and programmatic hooks are trusted host code. Command sandboxes cannot constrain those functions. Fully offline deployments must also constrain the model service and host process network.

Community implementations can already target provider, checkpointer, sandbox, permission and middleware interfaces. This migration does not add a plugin loader, privacy redaction or outbound model filtering. Local execution and log redaction must not be described as remote-model data protection.
