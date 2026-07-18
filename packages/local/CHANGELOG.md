# @lite-agent/local

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
