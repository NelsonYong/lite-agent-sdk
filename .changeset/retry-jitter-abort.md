---
"@lite-agent/core": patch
---

Harden the `retry()` middleware

- Default backoff now applies **full jitter** (a random delay in `[0, ceiling]`) so
  many agents recovering from the same transient failure don't retry in lockstep.
  A caller-supplied `backoff` is still used verbatim.
- Retries are now **abort-aware**: an aborted run stops retrying immediately and
  interrupts an in-progress backoff wait instead of sleeping it out.
- Each retried failure emits a non-fatal `error` event (`fatal: false`) for observability.
