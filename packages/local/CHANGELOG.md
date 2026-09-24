# @lite-agent/local

## 0.3.0

### Minor Changes

- Expose `LocalAgent.hook()` and support the SDK's global/project `hooks.json`
  lifecycle commands. Commands retain strict local permissions and sandbox
  enforcement; the new `hook` capability is denied unless explicitly authorized.

- Allow the session-scoped `context` retrieval tool and forward cancellation
  options through `LocalAgent.compact(instructions, options)`.

- Protect the SDK home, project `.lite-agent` directory and explicitly configured
  permission files from sandboxed shell writes. Existing scripts that write to
  these paths must use a permitted output location instead.

### Patch Changes

- Enforce hook reentrancy checks before changing local shutdown state, start
  closing the underlying agent before releasing persistence/sandbox resources,
  and remove outer abort listeners when a run fails to initialize.

## 0.2.1

### Patch Changes

- Forward `LiteAgent.awaitIdle()` through `LocalAgent`, so local callers can
  wait for the current session's subagent groups and autonomous completion turns
  with the same lifecycle contract as `@lite-agent/sdk`.

## 0.2.0

### Minor Changes

- Forward `LiteAgent.subscribe()` through `LocalAgent` so interactive local
  runtimes can observe autonomous background turns, and close the underlying
  session runner during `LocalAgent.close()` so detached work is cancelled
  before persistence and sandbox resources are released.

## 0.1.0

### Minor Changes

- Introduce the strict single-host `createLocalAgent()` assembly with local
  OpenAI-compatible runtime presets, codec auto-selection, SQLite WAL sessions,
  mandatory OS sandboxing, process resource limits, managed deny-by-default
  permissions, safe crash recovery, context budgets, durable permission audit,
  diagnostics and rotating hash-chained local event logs.
