# 权限

Agent 发起的每次工具调用在运行前都要经过一道**权限闸门**。`policy()` 用 `allow` / `ask` / `deny` 规则集匹配调用——按工具名 glob，或按调用的实际入参——由你决定哪些动作静默放行、哪些需要人工确认、哪些永远不允许。优先级恒为 **deny > ask > allow**：写错顺序的 allow 永远不可能盖住 deny。这就是让自主 agent 守在你划定的边界内的方式，并附带审计记录作为证明。

## 开启

把策略（以及可选的审批处理器）传给 `createLiteAgent`：

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

名称匹配使用 glob（`Task*` 匹配 `TaskCreate`、`TaskUpdate` 等）。没有命中任何规则的调用落到 `default`（不设置时为 `"allow"`）。不配策略时一切放行。

## 内容级规则

除了工具名，`policy({ rules })` 还可以通过 `when` 规范匹配**调用入参**——对 `command`、`path` 等点路径字段施加条件。SDK 为内置工具提供了现成的规则构造器：

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

规则即 `PermissionRule`：

| 字段 | 说明 |
| --- | --- |
| `tool` | 工具名 glob（字符串或列表）。 |
| `when` | `MatchSpec`：点路径 → 条件，多键之间取 AND。条件类型：`glob`、`regex`、`equals`、`in`、`startsWith`、`contains`、`not`。 |
| `where` | 任意谓词 `(call, ctx) => boolean`，用于 `when` 表达不了的场景。 |
| `effect` | `"allow"` \| `"ask"` \| `"deny"`。 |
| `id` / `description` | 溯源信息，会出现在判定结果与审计事件中。 |

:::tip
Bash 命令匹配是尽力而为的——shell 引号和命令链可以绕过前缀规则。权限闸门只是纵深防御的一层；真正的隔离边界是 [Sandbox](/zh/sdk/control/sandbox)。
:::

## 审计与 dry-run

- `permissionAudit: true` 会为每个决定向会话日志追加一条脱敏的 `permission_decision` 事件，包括决策者（`policy` / `user` / `auto`）。工具入参中的密钥由 `defaultRedactor` 掩码（可用 `redact` 覆盖）。
- `permissionMode: "dry-run"` 只计算并记录判定而**不拦截任何调用**——把候选策略对准真实流量，先看它会拒绝什么，再决定是否启用。

## 组合策略

- `composePolicies(...)` 以 **deny 优先**合并多个策略——托管层（例如组织基线）的 deny 无法被下游用户放松。
- `strictPolicy({ allow })` 提供默认拒绝姿态：只有你列出的才被允许。

```ts
import { composePolicies, strictPolicy, policy } from "@lite-agent/sdk";

const permission = composePolicies(
  policy({ deny: ["bash"] }),                // org baseline: bash is off-limits
  strictPolicy({ allow: ["read_file", "bash"] }), // user layer tries to re-allow it…
);                                             // …but deny wins: bash stays denied
```

:::warning
子代理默认**不带父级的权限闸门和 `onApproval` 处理器**运行——交互式审批无法服务并行的子代理。sandbox 仍会包裹每条命令。传 `subagentPermission`（allow/deny 规则，不支持 `ask`）来约束子代理运行。见 [子代理](/zh/sdk/tools/subagents)。
:::

## 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `permission` | — | 门控每次工具调用的 `PermissionPolicy`（`policy()` / `strictPolicy()` / `composePolicies()`）。 |
| `onApproval` | — | 人工审批处理器；其 `request(call)` 决定每个 `"ask"` 判定的结果。 |
| `permissionMode` | `"enforce"` | `"dry-run"` 只记录判定不拦截。 |
| `permissionAudit` | `false` | 在会话日志中持久化脱敏的权限判定。 |
| `redact` | `defaultRedactor` | 审计负载的脱敏器。 |
| `subagentPermission` | — | 应用于子代理运行的权限策略。 |

相关导出：`policy`、`strictPolicy`、`composePolicies`、`bashCommand`、`filePath`、`permissionFilePolicy`、`defaultRedactor`。

## 另请参阅

- [Sandbox](/zh/sdk/control/sandbox) — 与闸门组合的 OS 级隔离。
- [可观测性](/zh/sdk/control/observability) — 从事件流中读取 `permission_decision` 事件。
- [子代理](/zh/sdk/tools/subagents) — `subagentPermission` 如何约束子代理。
- [Core 策略](/zh/core/strategies) — `PermissionPolicy` 策略接口。
