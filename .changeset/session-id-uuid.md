---
"@lite-agent/sdk": patch
---

Generate session ids as UUID v4 (Claude Code-style, e.g. `be63a577-971d-4a42-a8fe-a572b7246431`) via `crypto.randomUUID()`, replacing the `s-<timestamp>-<rand>` form. Ids remain opaque strings, so previously created sessions still `resume`/`restore`; session listing already sorts by mtime, not by id.
