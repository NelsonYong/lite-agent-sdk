# Permissions

Every tool call an agent makes passes a **permission gate** before it runs. `policy()` matches calls against `allow` / `ask` / `deny` rule sets — by tool name glob, or by the call's actual input — so you decide which actions run silently, which need a human, and which never happen. Precedence is always **deny > ask > allow**: a mis-ordered allow can never shadow a deny. This is how you keep an autonomous agent inside the lines you drew, with an audit trail to prove it.

## Enable it

Pass a policy (and optionally an approval handler) to `createLiteAgent`:

```ts
import { createLiteAgent, policy, bashCommand, filePath } from "@lite-agent/sdk";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  permission: policy({
    allow: ["read_file", "Task*"],
    ask: ["write_file", "edit_file"],
    deny: ["bash"],
  }),
  onApproval: {
    // human-in-the-loop: decide each "ask" call
    request: async (call) => (confirm(`Allow ${call.name}?`) ? "allow" : "deny"),
  },
  permissionAudit: true, // persist redacted decisions in the session event log
});
```

Name matching uses globs (`Task*` matches `TaskCreate`, `TaskUpdate`, …). A call that matches no rule falls through to `default` (`"allow"` unless you set it). Without a policy, everything is allowed.

## Content-level rules

Beyond tool names, `policy({ rules })` matches on **call input** via a `when` spec — conditions over dot-paths into the input like `command` or `path`. The SDK ships ready-made specifiers for its own tools:

```ts
permission: policy({
  rules: [
    bashCommand("rm -rf*", "deny"),        // block destructive shell commands
    bashCommand("git status*", "allow"),   // `:*` desugars to a prefix match
    filePath("src/**", "allow"),           // allow file tools under ./src
    filePath("**/.env*", "deny"),          // …but never touch env files
  ],
  default: "ask",
}),
```

A rule is a `PermissionRule`:

| Field | Description |
| --- | --- |
| `tool` | Tool name glob (string or list). |
| `when` | `MatchSpec`: dot-path → condition, ANDed across keys. Conditions: `glob`, `regex`, `equals`, `in`, `startsWith`, `contains`, `not`. |
| `where` | Arbitrary predicate `(call, ctx) => boolean` for cases a `when` spec can't express. |
| `effect` | `"allow"` \| `"ask"` \| `"deny"`. |
| `id` / `description` | Provenance surfaced in verdicts and audit events. |

:::tip
Bash command matching is best-effort — shell quoting and chaining can bypass prefix rules. The permission gate is defense-in-depth; the [sandbox](/sdk/control/sandbox) is the real containment.
:::

## Auditing and dry-run

- `permissionAudit: true` appends a redacted `permission_decision` event to the session log for every decision, including who made it (`policy` / `user` / `auto`). Secrets in tool input are masked by `defaultRedactor` (override with `redact`).
- `permissionMode: "dry-run"` computes and records verdicts **without blocking anything** — point a candidate policy at real traffic to see what it would deny before enforcing it.

## Composing policies

- `composePolicies(...)` merges policies **deny-wins** — a managed layer (e.g. your org's baseline) downstream users cannot loosen.
- `strictPolicy({ allow })` gives a deny-by-default posture: only what you list is permitted.

```ts
import { composePolicies, strictPolicy, policy } from "@lite-agent/sdk";

const permission = composePolicies(
  policy({ deny: ["bash"] }),                // org baseline: bash is off-limits
  strictPolicy({ allow: ["read_file", "bash"] }), // user layer tries to re-allow it…
);                                             // …but deny wins: bash stays denied
```

:::warning
Subagents run **without the parent's permission gate and `onApproval` handler** by default — an interactive approval handler cannot service parallel children. The sandbox still wraps every command. Pass `subagentPermission` (allow/deny rules, not `ask`) to gate subagent runs. See [Subagents](/sdk/tools/subagents).
:::

## Options

| Option | Default | Description |
| --- | --- | --- |
| `permission` | — | `PermissionPolicy` gating every tool call (`policy()` / `strictPolicy()` / `composePolicies()`). |
| `onApproval` | — | Human-in-the-loop handler; its `request(call)` decides each `"ask"` verdict. |
| `permissionMode` | `"enforce"` | `"dry-run"` records decisions without blocking. |
| `permissionAudit` | `false` | Persist redacted permission decisions in the session log. |
| `redact` | `defaultRedactor` | Redactor for audit payloads. |
| `subagentPermission` | — | Permission policy applied to subagent runs. |

Related exports: `policy`, `strictPolicy`, `composePolicies`, `bashCommand`, `filePath`, `permissionFilePolicy`, `defaultRedactor`.

## See also

- [Sandbox](/sdk/control/sandbox) — OS-level containment that composes with the gate.
- [Observability](/sdk/control/observability) — reading `permission_decision` events out of the event stream.
- [Subagents](/sdk/tools/subagents) — how `subagentPermission` gates child agents.
- [Core strategies](/core/strategies) — the `PermissionPolicy` strategy interface.
