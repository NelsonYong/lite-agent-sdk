---
"@lite-agent/sdk": patch
---

refactor(sdk): parse `SKILL.md` frontmatter with `gray-matter`

`SkillLoader` now uses the `gray-matter` library instead of a hand-rolled line splitter, so skill frontmatter is parsed as real YAML (arrays, quoted values, nested keys) rather than flat `key: value` strings.
