---
"@lite-agent/core": patch
"@lite-agent/sdk": patch
---

Replace hand-rolled internals with maintained libraries: the two concurrency worker-pools (kernel tool pool, Agent subagent pool) now use `p-limit`, and the permission tool-name matcher uses `picomatch` instead of a hand-rolled glob→regexp. Behavior is unchanged for existing tool-name patterns; the permission matcher additionally supports brace (`{a,b}`) and character-class (`[…]`) globs.
