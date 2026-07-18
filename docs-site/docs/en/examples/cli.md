# examples/cli

An interactive REPL (`examples/cli`, package `@lite-agent/example-cli`) that wires the **full stack** on top of [`@lite-agent/sdk`](/sdk/overview):

- streaming agent loop via `createLiteAgent`, driven by a provider from [`@lite-agent/provider`](/core/providers)
- **permission gate** — asks before `bash` / `write_file` / `edit_file`
- **OS-level sandbox** via [`@lite-agent/sandbox-anthropic`](/sdk/control/sandbox) — degrades to noop on unsupported environments
- **`ask_user`** — the model can ask you questions (free text or numbered options)
- session management — list / resume / clear / delete sessions from the REPL
- multi-line paste, `ESC` to interrupt a run

Use it as a runnable reference for how to wire your own app.

## Run

From the monorepo root:

```bash
pnpm install
cp examples/cli/.env.example examples/cli/.env   # then fill in your key
pnpm dev        # = pnpm --filter @lite-agent/example-cli dev → tsx src/main.ts
```

:::tip
The agent operates on the directory you launch it from (`process.cwd()`), while `.env` and skills always load from `examples/cli/` itself — so you can `cd` into any project directory and run the REPL against it.
:::

## Configuration

Config is read from `examples/cli/.env` (via `dotenv`). All variables use the `LITE_AGENT_` prefix:

| Variable | Required | Description |
| --- | --- | --- |
| `LITE_AGENT_MODEL_ID` | yes | Model id, e.g. `claude-sonnet-4-6` |
| `LITE_AGENT_MODEL_API_KEY` | yes | API key for the model endpoint |
| `LITE_AGENT_BASE_URL` | no | Custom endpoint (proxy / compatible gateway) |
| `LITE_AGENT_MODEL_PROTOCOL` | no | `anthropic` or `openai`. Inferred from the model id when unset: `claude*` / `anthropic*` → `anthropic`, otherwise `openai` |

`src/model.ts` turns these into a provider (`anthropic(...)` or `openai(...)` from `@lite-agent/provider`); protocol auto-detection means the same `.env` shape works for Claude and for OpenAI-compatible endpoints.

## How it's wired

Everything happens in one `createLiteAgent` call (`src/main.ts`):

```ts
const agent = createLiteAgent({
  model: provider,                    // from @lite-agent/provider
  modelName,
  workdir: process.cwd(),             // the agent acts on your launch directory
  skillsDir: join(exampleRoot, "skills"),
  permission: policy({ ask: ["bash", "write_file", "edit_file"] }),
  onApproval,                         // ApprovalHandler — y/N prompt
  onAskUser,                          // InputHandler — [ask] prompt
  sandbox: sandboxRuntime({           // OS boundary (Seatbelt / bubblewrap)
    allowedDomains: ["registry.npmjs.org", "api.github.com", "github.com", ...],
    denyRead: ["~/.ssh", "~/.aws"],
    onUnavailable: (err) => /* warn and continue unsandboxed */,
  }),
});
```

The wiring pattern worth copying:

- **Policy + handlers are separate.** `policy({ ask: [...] })` decides *when* to ask; `onApproval` / `onAskUser` decide *how* to ask. Swap the handlers for a GUI, a Slack bot, or an auto-approver without touching the policy.
- **Sandbox is defense-in-depth.** The permission gate controls intent; the sandbox enforces an OS-level boundary regardless. `onUnavailable` keeps `bash` working where Seatbelt/bubblewrap is missing.
- **Server-side history.** Each turn sends only the new message — `agent.run([{ role: "user", content: text }])` — and the kernel reloads the transcript via the agent's current `sessionId`.

## In the REPL

Input that doesn't start with `/` is sent to the model. `q` or `exit` quits.

### Slash commands

Handled locally (never sent to the model):

| Command | Action |
| --- | --- |
| `/sessions` | List stored sessions (id + last-modified time) |
| `/resume <id>` | Switch to an existing session; history continues from it |
| `/clear` | Start a fresh session |
| `/delete <id>` | Delete a stored session |

### Approvals and questions

- **`[approve] bash {...}? [y/N]`** — the permission gate intercepted a tool call. Press `y` to allow, anything else to deny. The keypress is read in raw mode, so there's no Enter to hit.
- **`[ask] ...`** — the model invoked `ask_user`. Type free text, or the number(s) of the listed options (comma-separated for multi-select questions), then Enter.
- **`ESC`** — aborts the current run mid-stream and returns to the prompt.
- **Pasting multiple lines** switches the prompt to multi-line mode; submit with a blank line.

### What you see while a run streams

The REPL renders the typed `AgentEvent` stream from `agent.run()` directly:

| Event | Rendered as |
| --- | --- |
| `text_delta` | streamed model text |
| `tool_use` | green `[tool] name {input}` line |
| `tool_result` | gray result body (truncated at 500 chars) |
| `approval_resolved` | `[approved]` / `[denied]` |
| `error` | red `[error] message` |
| `done` | end of turn |

## As a wiring reference

If you're building your own UI on the SDK, `src/main.ts` (~290 lines, no dependencies beyond the packages and `dotenv`) shows the minimal complete loop: resolve a provider from env → `createLiteAgent` with policy + handlers + sandbox → consume the `AgentEvent` stream from `agent.run()` → route approvals / questions back through the handlers. Start from [Getting started](/sdk/getting-started) for the step-by-step version.
