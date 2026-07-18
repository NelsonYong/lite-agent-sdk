# Built-in tools

`@lite-agent/sdk` ships a working tool set out of the box — shell access, workspace-scoped file tools, a persistent task list, subagent dispatch, and more — so a fresh agent is productive with zero setup. All built-ins are registered by default and can be filtered or disabled per tool or per capability.

## Tool reference

| Tool | Description |
| --- | --- |
| `bash` | Run a shell command in the workspace (builds, tests, git, search). `run_in_background: true` detaches long-running commands. |
| `read_file` | Read a file's contents, with an optional line `limit` for large files. |
| `write_file` | Create or overwrite a file atomically; parent directories are created automatically. |
| `edit_file` | Replace the first exact occurrence of `old_text` with `new_text` in a file. |
| `delete_file` | Delete a file (snapshotted first, so `restore()` can recreate it). |
| `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` | Persistent task list for multi-step work. |
| `Agent` | Delegate subtasks to [subagents](/sdk/tools/subagents). |
| `load_skill` | Load a [skill](/sdk/tools/skills)'s body into context on demand. |
| `BashOutput` | Read incremental output from a backgrounded `bash` command by its `bg_…` id. |
| `KillBackground` | Cancel a running background task by id. |
| `ask_user` | Ask the user a question mid-run — registered only when `onAskUser` is set. |
| `final_answer` | Return the validated structured answer — registered only when `outputSchema` is set. |

The file tools are scoped to `workdir`, write atomically, and snapshot every file before changing it so session restore can undo the change.

## Disabling tools

Filter the final tool set by name with `allowedTools` (allow-list) or `disallowedTools` (deny-list):

```ts
const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  disallowedTools: ["bash", "delete_file"],
});
```

Whole capabilities (and their tools) can be switched off with a single flag:

| Option | Effect |
| --- | --- |
| `tasks: false` | Removes `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` and the task reminder. |
| `agents: false` | Removes `Agent` and the whole subagent capability. |
| `background: false` | Removes `BashOutput` / `KillBackground` and the background-task feature. |

:::tip
Filtering hides tools from the model; the [permission gate](/sdk/control/permissions) decides what may actually run. Use both: filter for focus, gate for safety.
:::

The built-in tool sets are also individually importable — `defaultTools`, `bashTool`, `fileTools`, `taskTools`, `agentTool`, `askUserTool`, `bashOutputTool`, `killBackgroundTool` — for assembling your own agent on the kernel.

## See also

- [Custom tools](/sdk/tools/custom-tools) — add your own tools with `tool()`.
- [Subagents](/sdk/tools/subagents) — what the `Agent` tool delegates to.
- [Skills](/sdk/tools/skills) — what `load_skill` loads.
- [Permissions](/sdk/control/permissions) — gate tool calls with allow / ask / deny rules.
