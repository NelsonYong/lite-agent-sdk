# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

lite-agent is a TypeScript CLI-based agentic framework that uses the Anthropic Claude API to build conversational agents with tool-use capabilities. It features message compression, skill loading, sub-agent delegation, and file-safe operations.

## Commands

- **Dev:** `pnpm dev` — runs `tsx src/main.ts`
- **Build:** `pnpm build` — compiles TypeScript via `tsc`
- **Start:** `pnpm start` — runs compiled `node dist/main.js`
- **Typecheck:** `pnpm typecheck` — `tsc --noEmit`
- **Package manager:** pnpm (pinned 10.12.4)

No test runner or linter is configured.

## Architecture

Single-package CLI application using an agentic loop pattern.

```
src/
  main.ts              # CLI REPL entry, workspace safety (safePath)
  agent/
    index.ts           # Core agent loop (liteAgent) — calls Claude API, dispatches tools, loops until no more tool_use
    client.ts          # Anthropic SDK singleton (getClient)
    subagent.ts        # Spawns isolated sub-agents (shared FS, isolated message history)
    skill.ts           # SkillLoader — discovers/loads SKILL.md files with YAML frontmatter
    compact.ts         # Message compression: microCompact (80K threshold) and autoCompact (150K threshold)
  tools/
    index.ts           # Tool registry: schemas + toolHandlers dispatch map
    bash.ts            # Shell execution via execSync (with dangerous command filter)
    file.ts            # File read/write/edit (safePath enforced, 50KB limit)
    todo.ts            # Todo list manager (singleton, file-based)
    task.ts            # Task tracker with dependencies
  prompt/
    system.ts          # System prompt builders
skills/                # Skill definitions — each has SKILL.md with YAML frontmatter + assets
```

### Key flow

1. User input → message history → `liteAgent()` called
2. Agent loop: compress messages if needed → Claude API call with tools → parse tool_use blocks → execute tools → append results → repeat until model stops calling tools
3. Compression: `microCompact()` replaces old tool_result content at 80K input tokens; `autoCompact()` summarizes full conversation at 150K total tokens. Transcripts saved to `.transcripts/` as JSONL.

### Key patterns

- **Workspace safety:** All file paths validated through `safePath()` to prevent escaping WORKDIR
- **Tool dispatch:** Tools defined as schema + handler; `toolHandlers` map used for dispatch; errors returned as tool_result content strings
- **Singletons:** Anthropic client, SkillLoader, Todo/Task managers
- **Skills:** Loaded from `skills/` subdirectories, each containing a `SKILL.md` with YAML frontmatter (name, description, tags) and markdown body
- **Config:** `.env` file with ANTHROPIC_API_KEY, BASE_URL, MODEL_ID

## Tech Stack

- TypeScript 6.0 (strict mode, ES2022 target)
- `@anthropic-ai/sdk` for Claude API
- `dotenv` for env config
- `zod` available but currently unused
- Native `readline`, `fs`, `child_process` for CLI/FS/exec
