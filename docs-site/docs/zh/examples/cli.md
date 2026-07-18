# examples/cli

一个交互式 REPL 示例（`examples/cli`，包名 `@lite-agent/example-cli`），在 [`@lite-agent/sdk`](/zh/packages/sdk) 之上串起**全栈**：

- 基于 `createLiteAgent` 的流式 agent 循环，由 [`@lite-agent/provider`](/zh/packages/provider) 提供的 provider 驱动
- **权限门禁** —— 执行 `bash` / `write_file` / `edit_file` 前先询问
- **OS 级沙箱**，来自 [`@lite-agent/sandbox-anthropic`](/zh/packages/sandbox-anthropic) —— 在不支持的环境中降级为 noop
- **`ask_user`** —— 模型可以反问你（自由文本或编号选项）
- 会话管理 —— 在 REPL 内列出 / 恢复 / 清空 / 删除会话
- 多行粘贴、`ESC` 中断当前运行

可以把它当作接线你自己应用的可运行参考。

## 运行

在 monorepo 根目录执行：

```bash
pnpm install
cp examples/cli/.env.example examples/cli/.env   # 然后填入你的 key
pnpm dev        # = pnpm --filter @lite-agent/example-cli dev → tsx src/main.ts
```

:::tip
agent 操作的是你启动它时所在的目录（`process.cwd()`），而 `.env` 和 skills 始终从 `examples/cli/` 自身加载——所以你可以 `cd` 到任意项目目录，再针对它运行这个 REPL。
:::

## 配置

配置从 `examples/cli/.env` 读取（通过 `dotenv`），所有变量都带 `LITE_AGENT_` 前缀：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LITE_AGENT_MODEL_ID` | 是 | 模型 id，例如 `claude-sonnet-4-6` |
| `LITE_AGENT_MODEL_API_KEY` | 是 | 模型端点的 API key |
| `LITE_AGENT_BASE_URL` | 否 | 自定义端点（代理 / 兼容网关） |
| `LITE_AGENT_MODEL_PROTOCOL` | 否 | `anthropic` 或 `openai`。不设置时按模型 id 推断：`claude*` / `anthropic*` → `anthropic`，否则 `openai` |

`src/model.ts` 把这些变量变成一个 provider（`@lite-agent/provider` 的 `anthropic(...)` 或 `openai(...)`）；协议自动检测意味着同一份 `.env` 结构既能用于 Claude，也能用于 OpenAI 兼容端点。

## 接线方式

全部装配都在一次 `createLiteAgent` 调用里（`src/main.ts`）：

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

值得照搬的接线模式：

- **策略与处理器分离。** `policy({ ask: [...] })` 决定*何时*询问；`onApproval` / `onAskUser` 决定*如何*询问。把处理器换成 GUI、Slack 机器人或自动批准器，都不用动策略。
- **沙箱是纵深防御。** 权限门禁控制意图；沙箱则无视意图、在 OS 层面强制边界。`onUnavailable` 保证在没有 Seatbelt/bubblewrap 的环境里 `bash` 仍可用。
- **服务端历史。** 每轮只发送新消息——`agent.run([{ role: "user", content: text }])`——内核通过 agent 当前的 `sessionId` 重新加载会话记录。

## REPL 内的交互

不以 `/` 开头的输入会发给模型。输入 `q` 或 `exit` 退出。

### 斜杠命令

在本地处理（不会发给模型）：

| 命令 | 作用 |
| --- | --- |
| `/sessions` | 列出已存储的会话（id + 最后修改时间） |
| `/resume <id>` | 切换到已有会话，从其历史继续 |
| `/clear` | 开始一个全新的会话 |
| `/delete <id>` | 删除一个已存储的会话 |

### 审批与提问

- **`[approve] bash {...}? [y/N]`** —— 权限门禁拦截了一次工具调用。按 `y` 允许，按其他任何键拒绝。按键在 raw 模式下读取，无需回车。
- **`[ask] ...`** —— 模型调用了 `ask_user`。输入自由文本，或列出选项的编号（多选问题用逗号分隔），然后回车。
- **`ESC`** —— 在流式输出中途打断当前运行，返回提示符。
- **粘贴多行** 会让提示符进入多行模式；用空行提交。

### 运行过程中你会看到什么

REPL 直接渲染 `agent.run()` 产出的类型化 `AgentEvent` 流：

| 事件 | 渲染为 |
| --- | --- |
| `text_delta` | 流式输出的模型文本 |
| `tool_use` | 绿色的 `[tool] name {input}` 行 |
| `tool_result` | 灰色的结果正文（截断到 500 字符） |
| `approval_resolved` | `[approved]` / `[denied]` |
| `error` | 红色的 `[error] message` |
| `done` | 本轮结束 |

## 作为接线参考

如果你要基于 SDK 构建自己的 UI，`src/main.ts`（约 290 行，除各包和 `dotenv` 外没有依赖）展示了最小完整循环：从环境变量解析 provider → 用策略 + 处理器 + 沙箱调用 `createLiteAgent` → 消费 `agent.run()` 的 `AgentEvent` 流 → 通过处理器把审批 / 提问送回内核。循序渐进版本见[快速上手](/zh/guide/getting-started)。
