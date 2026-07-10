# @lite-agent/local

**English** | [简体中文](./README.zh-CN.md)

Strict single-host assembly for lite-agent. It combines a declared local model, SQLite WAL persistence, mandatory OS sandboxing, deny-by-default managed permissions, crash-safe tool tracking, bounded resources, binary file restore, and a redacted hash-chained local event log.

## Install

```bash
pnpm add @lite-agent/local zod
```

`better-sqlite3` and `@anthropic-ai/sandbox-runtime` are native/runtime dependencies. Strict mode targets macOS and Linux.

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

`codec: "auto"` selects native tool calls only when `nativeTools` is true; otherwise it uses `jsonCodec`. `reactCodec` is explicit-only.

## Strict defaults

- Provider endpoint must be loopback or a Unix socket and passes a startup health probe.
- SQLite uses WAL, `synchronous=FULL`, integrity checking, and safe interrupted-tool recovery.
- Bash has no network, a filtered environment, mandatory sandbox initialization, 120 s foreground wall/CPU time, a 30 min background wall limit, at most four background tasks, 2 GiB process-tree memory, 128 processes, and 5 MiB output.
- File mutations reject symlinks, use atomic replacement, and persist UTF-8/base64 snapshots before changing data.
- Permissions are deny-by-default. Read-only built-ins are allowed; mutating tools require an explicit `ask` or `allow` rule.
- Unknown custom tools are rejected unless they declare `security`; offline mode accepts only `network: "none" | "loopback"`.
- Events are redacted and written to a 10 MiB rotating SHA-256 chain; set `LITE_AGENT_AUDIT_KEY` for HMAC.

Runtime data lives under the SDK project directory: `sessions.sqlite3` and `logs/events.jsonl`.

## Permission files

Discovery order is managed (`LITE_AGENT_MANAGED_PERMISSIONS`), user (`~/.lite-agent/permissions.json`), project (`.lite-agent/permissions.json`), then inline rules. Deny wins globally, so a managed deny cannot be overridden.

```json
{
  "version": 1,
  "rules": [
    { "id": "edit-src", "tool": ["write_file", "edit_file"], "when": { "path": { "glob": "src/**" } }, "effect": "allow" },
    { "id": "review-bash", "tool": "bash", "effect": "ask" }
  ]
}
```

Use `queryAudit()` for structured permission decisions or `exportAudit()` for NDJSON. Permission files reload on change; malformed updates fail closed.

## Local runtimes

`localOpenAI` includes loopback presets for `ollama`, `vllm`, `lm-studio`, and `llama.cpp`. vLLM/llama.cpp use their local tokenize endpoint when available; other runtimes use an injected estimator or a conservative bytes/3 estimate reported by `diagnostics()`.
