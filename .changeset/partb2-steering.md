---
"@lite-agent/core": minor
"@lite-agent/sdk": minor
---

Add turn-boundary steering: a `SteerController` (mirroring `AbortController`) with `steer(msg)` to inject input before the next model turn and `followUp(msg)` to continue a run that would otherwise stop. Pass it via `run`/`query` options (`{ steer }`). Injections surface as an additive `steer` event. No interruption of in-flight model streams. Purely additive — runs without a controller are unchanged.
