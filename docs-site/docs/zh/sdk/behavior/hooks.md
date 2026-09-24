# Hooks

通过 `agent.hook(name, handler, options?)` 注册需要等待完成的阶段处理。同名事件可以注册多个回调，同一个函数也可以重复注册；返回值只注销对应的那一次注册。

```ts
const agent = createLiteAgent({ model, workdir });
const removeAudit = agent.hook("run:end", async ({ status, result, runId }, { signal }) => {
  await saveAudit({ runId, status, text: result?.text }, { signal });
});
agent.hook("run:end", async ({ status }) => {
  console.log(status);
});
removeAudit();
```

## 事件

| 事件 | 身份信息以外的字段 |
| --- | --- |
| `run:start` | `input` |
| `run:end` | `status`、可选 `result`、`error` |
| `tool:start` | `call` |
| `tool:end` | `call`、`status`、可选 `result/error`、`durationMs` |
| `compact:start` | `compactionId`、`kind`、`before`、可选手动压缩 `instructions` |
| `compact:end` | `compactionId`、`kind`、`before`、`after`、`status`、可选 `error` |

身份信息包括 `event`、`runId`、`sessionId`、`source`（`user/background/manual`）及可选 `agentId`（根实例不设置）。根实例的注册也覆盖子代理；子代理和后台轮次各有独立 runId。`run:end` 表示本轮结束，不代表所有 detached 工作完成。运行结果包含文本、usage、停止原因和可选结构化输出，不复制完整对话。

状态为 `completed`、`failed`、`cancelled`、`max_turns`。工具被权限拒绝也属于失败结果。`tool:start` 表示一次调用尝试，包括随后被拒绝的尝试；`tool:end` 在工具／中间件返回后、内核归档和持久化该结果前执行。回调收到冻结副本，不能改变真实调用参数和结果，返回值也不会改变流程。

单次事件内按注册顺序串行执行，不同工具／子代理仍可并发。一次分发会固定当时的回调列表，注册或注销影响后续分发。运行时会等待 Hook；观察进度使用 `subscribe()`。

回调失败会产生 `diagnostic` 事件，`code` 为 `hook_failed`，其余回调继续执行。它不会把成功工具改成失败，也不会导致工具重试。Hook 不承担权限拦截，也不保证跨崩溃恰好执行一次；外部副作用应使用 run/call/compaction ID 做幂等控制。

每个回调默认超时 10 秒，可通过 `{ timeoutMs }` 设置 1～120000 毫秒。第二个参数提供 AbortSignal。失败和取消也会触发 end 回调，使用独立、有超时的收尾 signal。JavaScript 回调属于可信宿主代码，应配合取消；SDK 无法强制终止任意同进程代码。

不要在 Hook 内等待同一 Agent 家族的 `run/send/awaitIdle/compact/restore/deleteSession/close`，这会等待正在执行 Hook 的操作，SDK 会明确拒绝。后续工作应在回调返回后调度。`close()` 等待结束回调并清理根注册表，关闭后禁止新增注册。

## 全局和项目 hooks.json

创建根 Agent 时会一次性加载：

1. `<home>/hooks.json`，通常为 `~/.lite-agent/hooks.json`，可由 `home` 或 `LITE_AGENT_HOME` 改变。
2. `<workdir>/.lite-agent/hooks.json`。

顺序是全局数组、项目数组、程序注册；项目不会覆盖全局回调，同一个物理文件只加载一次。可执行配置不热加载，修改后创建新实例。配置无效时启动报错。`hookFiles: false` 可关闭文件发现，仍保留 `agent.hook()`。

```json
{
  "version": 1,
  "hooks": {
    "tool:end": [
      { "match": "write_file", "command": "node scripts/record-change.mjs", "timeoutMs": 10000 },
      { "match": "write_file", "command": "node scripts/update-index.mjs" }
    ],
    "run:end": [
      { "command": "node scripts/record-run.mjs" }
    ]
  }
}
```

同名事件使用数组，不要重复 JSON key。`match` 为可选的工具名 glob，只用于工具事件。命令以 `workdir` 为 cwd，通过 stdin 接收一条 JSON 事件；不会把事件数据拼接进 Shell。stdout 不送给模型，也不能控制 Agent；非零退出、超时、输出超限会产生诊断。输入上限 256 KiB，stdout/stderr 合计上限 64 KiB。

## 命令权限

文件命令使用独立于 `bash` 的 **`hook` 权限能力**。SDK 默认请求审批，没有处理器就拒绝；strict local 默认拒绝。可以精确授权某个命令：

```ts
permission: policy({
  default: "deny",
  allow: ["read_file", "context"],
  rules: [{
    tool: "hook",
    when: {
      event: { equals: "run:end" },
      source: { equals: "project" },
      command: { equals: "node scripts/record-run.mjs" },
    },
    effect: "allow",
  }],
}),
```

权限输入包含 `command/event/source/configFile`。自定义策略会替换 SDK 默认值，启用文件 Hook 时应检查原有默认允许策略。Hook 命令始终执行权限校验，不随模型工具的 dry-run 放行。命令复用已配置的沙箱和资源限制；未配置沙箱时，批准后的命令在宿主机执行。默认仅继承 PATH/HOME/TMPDIR/LANG/LC_ALL/TERM，显式 `bash.env` 由宿主负责。开启权限审计后也会记录 Hook 命令的决策。

程序回调属于可信宿主代码，不是沙箱命令。命令权限和沙箱统一在 `createLiteAgent()` 配置。`query()` 支持文件 Hook，程序注册使用 `createLiteAgent()`。
