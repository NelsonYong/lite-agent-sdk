# @lite-agent-sdk/example-cli

Interactive REPL example built on [`lite-agent-sdk`](../../packages/sdk). Demonstrates the full stack:

- streaming agent loop via `createLiteAgent` + the Anthropic provider
- **permission gate** — asks before `bash` / `write_file` / `edit_file`
- **OS-level sandbox** (`@lite-agent-sdk/sandbox-anthropic`) — degrades to noop on unsupported environments
- **`ask_user`** — the model can ask you questions (free text or numbered options)
- multi-line paste, `ESC` to interrupt a run

## Run

From the monorepo root:

```bash
pnpm install
pnpm --filter @lite-agent-sdk/example-cli dev   # or: pnpm dev
```

Configuration is read from this directory's `.env` (copy `.env.example` → `.env`):

```
ANTHROPIC_API_KEY=...
BASE_URL=...
MODEL_ID=...
MONITOR_PORT=8899   # optional
```

The agent operates on the directory you launch it from (`process.cwd()`); skills are loaded from this example's own `skills/`.
