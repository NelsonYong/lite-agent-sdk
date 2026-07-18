# @lite-agent/example-cli

Interactive REPL example built on [`lite-agent`](../../packages/sdk). Demonstrates the full stack:

- streaming agent loop via `createLiteAgent` + the Anthropic provider
- **permission gate** — asks before `bash` / `write_file` / `edit_file`
- **OS-level sandbox** (`@lite-agent/sandbox-anthropic`) — degrades to noop on unsupported environments
- **`ask_user`** — the model can ask you questions (free text or numbered options)
- multi-line paste, `ESC` to interrupt a run

## Run

From the monorepo root:

```bash
pnpm install
pnpm --filter @lite-agent/example-cli dev   # or: pnpm dev
```

Configuration is read from this directory's `.env` (copy `.env.example` → `.env`):

```
LITE_AGENT_MODEL_ID=claude-sonnet-4-6
LITE_AGENT_MODEL_API_KEY=sk-...
LITE_AGENT_BASE_URL=https://api.anthropic.com
# Optional: force the protocol (inferred from the model id otherwise).
# LITE_AGENT_MODEL_PROTOCOL=anthropic
```

The agent operates on the directory you launch it from (`process.cwd()`); skills are loaded from this example's own `skills/`.
