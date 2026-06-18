# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

lite-agent is a TypeScript CLI-based agentic framework that uses the Anthropic Claude API to build conversational agents with tool-use capabilities. Beyond a single agent loop, it includes an autonomous **multi-agent team**, **git-worktree isolation**, **background task execution**, a **task board with dependencies**, message compression, skill loading, and a live **memory monitor**.

## Commands

- **Dev:** `pnpm dev` — runs `tsx src/main.ts` (the interactive REPL)
- **Build:** `pnpm build` — compiles TypeScript via `tsc`
- **Start:** `pnpm start` — runs compiled `node dist/main.js`
- **Typecheck:** `pnpm typecheck` — `tsc --noEmit`
- **Package manager:** pnpm (pinned 10.12.4)

No test runner is configured (`pnpm test` is a placeholder that exits 1). A `pnpm lint` script references `eslint`, but eslint is **not** in `devDependencies`, so it will fail unless installed. Typecheck is the only working static check.

Requires a `.env` file (see `.env`): `ANTHROPIC_API_KEY`, `BASE_URL`, `MODEL_ID`. Optional `MONITOR_PORT` (default 8899).

## Architecture

Single-package CLI application using an agentic loop pattern.

```
src/
  main.ts              # CLI REPL entry: prompt loop, REPL commands, ESC interrupt, safePath
  monitor.ts           # Memory-monitor HTTP/SSE dashboard — auto-starts on import (port 8899)
  agent/
    index.ts           # Core agent loop (liteAgent) — Claude API call, tool dispatch, loop until no tool_use
    client.ts          # Anthropic SDK singleton (getClient)
    subagent.ts        # runSubagent — isolated one-shot sub-agent (shared FS, isolated history, base tools only)
    agentTeam.ts       # MessageBus + TeammateManager — autonomous multi-agent team (see docs/agentTeam.md)
    worktree.ts        # WorktreeManager + EventBus — git worktree lifecycle (see docs/worktree.md)
    background.ts      # BackgroundManager — async/daemon command execution with a notification queue
    skill.ts           # SkillLoader — discovers/loads SKILL.md files with YAML frontmatter
    compact.ts         # Message compression: microCompact (80K threshold) and autoCompact (150K threshold)
  tools/
    index.ts           # Tool registry: schemas (mainAgentTools / subagentTools) + toolHandlers dispatch map
    bash.ts            # Shell execution via execSync (with dangerous command filter)
    file.ts            # File read/write/edit (safePath enforced, 50KB limit)
    todo.ts            # Todo list manager (singleton, file-based)
    task.ts            # TaskManager — task board with owners + blockedBy/blocks dependencies (.tasks/)
  prompt/
    system.ts          # System prompt builders (main agent vs subagent)
skills/                # Skill definitions — each has SKILL.md with YAML frontmatter + assets
docs/                  # agentTeam.md, worktree.md — deep design docs for those subsystems
```

Runtime-generated dirs (created on first use, git-ignored in spirit): `.inbox/` (team message bus), `.team/config.json` (team roster), `.tasks/` (task board), `.worktrees/` (worktree index + events), `.transcripts/` (autoCompact JSONL dumps).

### Core agent loop (`liteAgent`)

1. User input → message history → `liteAgent()` called from `main.ts`
2. Each iteration: `microCompact` old tool results → (if >150K tokens) `autoCompact` → drain background notifications and the lead inbox into the history → Claude API call with `mainAgentTools` → execute `tool_use` blocks via `toolHandlers` → append results → repeat until `stop_reason !== "tool_use"`.
3. The `compact` tool triggers a manual `autoCompact`. A `<reminder>Update your todos.</reminder>` is injected after 3 rounds without a `todo` call.
4. Interruptible: `main.ts` wires ESC (raw-mode key listener) to an `AbortController`; the loop checks `signal.aborted` between steps.

### Compression (`compact.ts`)

- `microCompact()` — at ≥80K input tokens, replaces all but the last 3 tool_result bodies (>500 chars) with `[Compacted: used <tool> — "<200-char preview>..."]`. Runs every iteration.
- `autoCompact()` — at >150K total tokens (or manual `compact` tool), dumps full history to `.transcripts/transcript_<ts>.jsonl`, asks the model for a summary, and replaces the entire history with two messages.

### Delegation: two distinct mechanisms

The main agent has **two** ways to delegate — pick deliberately (the main system prompt enforces this):

- **`spawn_teammate` (Agent Team)** — autonomous, long-lived teammates for multi-role / parallel / ongoing work. They run their own `work → idle → poll → work` loop, auto-claim tasks from the board, and communicate async via the inbox. Use whenever the user asks for a "team", "协作", or multi-role work.
- **`agent` (Subagent, `runSubagent`)** — a blocking, one-shot isolated task. Shares the filesystem but has fresh history and **only base tools** (bash, file, todo — see `subagentTools`). Returns its final text.

### Agent Team (`agentTeam.ts`) — see `docs/agentTeam.md`

- **`MessageBus` (`BUS`)** — JSONL inboxes under `.inbox/{name}.jsonl`; `readInbox` is read-and-clear (one-shot consume, no ACK). The lead's inbox is drained into the main loop each iteration.
- **`TeammateManager` (`TEAM`)** — spawns teammates that run an autonomous loop (max 50 turns/phase, 60s idle timeout, 5xx retry). Roster persisted to `.team/config.json` with status `working | idle | shutdown`.
- **Governance protocols:** `plan_approval` (teammate must submit a plan and wait for lead approval before major work) and two-level shutdown — `shutdown_request` (graceful, teammate can refuse) vs `force_shutdown` (immediate, via in-memory `_forceShutdowns`).
- **Identity re-injection:** after compression shortens history, an `<identity>` block is re-injected so the teammate keeps its name/role.

### Task board (`task.ts`)

File-per-task under `.tasks/task_<id>.json`. Tasks have `owner`, `status` (pending/in_progress/completed), `worktree`, and `blockedBy`/`blocks` dependency arrays. Completing a task clears it from dependents' `blockedBy`. Idle teammates auto-claim via `scanAssigned(name)` (owner pre-assigned) then `scanUnclaimed()` (no owner, not blocked). `claimTask` uses a simple in-process `claimLock`.

### Worktrees (`worktree.ts`) — see `docs/worktree.md`

`WorktreeManager` (`WORKTREES`) wraps `git worktree` for isolated parallel work; creates branch `wt/<name>` under `.worktrees/<name>`, tracked in `.worktrees/index.json`. An `EventBus` (`EVENTS`) logs lifecycle events to `.worktrees/events.jsonl`. Repo root is auto-detected; ops no-op gracefully outside a git repo. Use worktrees when multiple teammates would otherwise edit the same files.

### Background tasks (`background.ts`)

`BackgroundManager` (`BG`) runs commands via `exec` and returns a `task_id` immediately. `daemon=true` disables the 300s timeout (for servers/watchers). Completions land in a notification queue that the main loop drains and surfaces as `<background-results>`.

### Memory monitor (`monitor.ts`)

Zero-dependency HTTP server (default port 8899) auto-started by `import "./monitor"` in `main.ts`. Serves an SSE dashboard charting `process.memoryUsage()` plus lifecycle events (`startup`, `agent_start`, `compact`, etc.). Call `mark(type, label)` to emit custom events. Serialization is skipped when no browser is connected; `server.unref()` so it never blocks process exit.

### REPL commands (`main.ts`)

- `/team` — print the team roster; `/inbox` — print the lead inbox.
- `/todo …` — force a `todo` tool call (`tool_choice`) on this turn.
- `q` / `exit` — quit. Multi-line paste is auto-detected (submit on blank line). ESC interrupts the running agent loop.

### Key patterns

- **Workspace safety:** main-agent file tools validate paths through `safePath()` (in `main.ts`) to prevent escaping WORKDIR. Note: the teammate `_exec` `read_file` reads directly and does **not** go through `safePath` (see ROADMAP.md P0).
- **Tool dispatch:** tools are `{schema}` + handler; `toolHandlers` maps name → handler; errors are caught and returned as tool_result strings, not thrown. `mainAgentTools` = base + team + worktree + task + agent + background + compact; `subagentTools` = base only.
- **Singletons:** Anthropic client, SkillLoader, plus the subsystem managers `BUS`, `TEAM`, `BG`, `WORKTREES`, `EVENTS`, `TASKS`, `TODO`.
- **Skills:** loaded from `skills/` subdirectories, each a `SKILL.md` with YAML frontmatter (name, description, tags); `load_skill` injects the body on demand.
- **Config:** `.env` with `ANTHROPIC_API_KEY`, `BASE_URL`, `MODEL_ID`, optional `MONITOR_PORT`.

## Tech Stack

- TypeScript 6.0 (strict mode, ES2022 target)
- `@anthropic-ai/sdk` for Claude API
- `dotenv` for env config
- `zod` is a dependency but currently unused
- Native `http`, `readline`, `fs`, `child_process` for the monitor/CLI/FS/exec

## Notes

- `ROADMAP.md` tracks known gaps, especially Agent Team hardening (path sandboxing for teammates, state-machine tool gating, durable message bus, error propagation). Treat the current team/worktree code as teaching-grade, not production-hardened.
