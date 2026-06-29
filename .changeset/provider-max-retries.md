---
"@lite-agent/provider": minor
---

Stop the providers from double-retrying

`openai()` and `anthropic()` now construct their SDK clients with `maxRetries: 0` by
default, and expose a `maxRetries` option. Previously each SDK retried transient
failures twice on its own, which **compounded** with the `retry()` middleware
(≈ 3 × 3 connection attempts and inflated backoff latency). Retry policy now has a
single owner — the `retry()` middleware — and `maxRetries` lets you restore
SDK-level retries when not using the middleware.
