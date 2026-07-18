# 系统提示词

每次 lite-agent 运行都从一段系统提示词开始，它为模型确立工作区上下文：可以在哪里操作、优先使用哪些工具、有哪些 skills 和 subagents 可用。SDK 通过 `buildSystemPrompt` 为你生成一段足够好的默认提示词——workdir、模型名称、可用 skills 和可用 subagents 都会自动填入——同时允许你在 agent 需要自己的语气、规则或领域上下文时替换或扩展它。

## 用法

给 `createLiteAgent` 传 `system`（或给 `query` 传 `systemPrompt`）即可**整体替换**内置提示词：

```ts
import { createLiteAgent } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  system: "You are a release-notes assistant. Answer concisely, in Markdown.",
});
```

`query()` 接受同一个字符串，但参数名为 `systemPrompt`：

```ts
import { query } from "@lite-agent/sdk";

for await (const ev of query({
  prompt: "Draft release notes for v0.4.0.",
  model: anthropic(),
  cwd: process.cwd(),
  systemPrompt: "You are a release-notes assistant. Answer concisely, in Markdown.",
})) {
  // ...
}
```

## 在默认提示词上追加

整体覆盖会丢掉内置的工作区约束。如果想**保留默认内容并追加自己的规则**，可以自己调用 `buildSystemPrompt` 再拼接——它就是 SDK 内部使用的同一个构建器，从 `@lite-agent/sdk` 导出：

```ts
import { createLiteAgent, buildSystemPrompt } from "@lite-agent/sdk";

const agent = createLiteAgent({
  model: anthropic(),
  modelName: "claude-sonnet-4-6",
  workdir: process.cwd(),
  system:
    buildSystemPrompt({ workdir: process.cwd(), skills: "" }) +
    "\n\n## House rules\n- Never commit directly to main.\n- Run pnpm test before finishing.",
});
```

`buildSystemPrompt(opts)` 接受一个 `SystemPromptOptions` 对象并返回提示词字符串：

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `workdir` | `string` | **必填。** 作为工作区边界写入提示词。 |
| `modelName` | `string` | 可选；添加一行 `Your model is …`。 |
| `skills` | `string` | 预渲染的可用 skills 列表，显示在 Skills 小节。 |
| `subagents` | `string` | 可选的预渲染可用 subagents 列表；追加 Subagents 小节。 |

:::warning
当你覆盖 `system` 时，SDK 不会再把自动生成的可用 skills / subagents 列表注入提示词。`load_skill` 和 `Agent` 工具仍然可用，但只有你的提示词告诉模型，它才知道该加载什么。
:::

## 默认提示词包含什么

`buildSystemPrompt` 生成一段紧凑的提示词，包含以下小节：

- **身份与边界** —— "You are lite-agent, a coding agent operating in `<workdir>`"；绝不访问其之外的路径。
- **核心原则** —— 优先用工具而非空谈。
- **文件操作** —— 用 `read_file` / `write_file` / `edit_file` / `delete_file` 代替 shell 等价命令；用 `bash` 执行命令和搜索。
- **任务规划** —— 3 步以上的工作用 `TaskCreate` 规划、用 `TaskUpdate` 跟踪（见[任务清单](/zh/sdk/behavior/tasks)）。
- **Skills** —— 用 `load_skill` 按需加载专业知识，后附自动发现的 skill 列表。
- **Subagents** —— 存在 subagents 时，说明何时以及如何用 `Agent` 工具委派（见 [Subagents](/zh/sdk/tools/subagents)）。

有两个能力在装配时扩展提示词，而不是通过 `system`：

- 设置 [`outputSchema`](/zh/sdk/behavior/structured-output) 会追加一个 `## Final answer` 小节，指示模型恰好调用一次 `final_answer`。
- [任务清单](/zh/sdk/behavior/tasks)的 reminder 以 `<system-reminder>` 消息的形式逐轮注入，而非写入系统提示词。

## 另请参阅

- [结构化输出](/zh/sdk/behavior/structured-output) —— 设置 `outputSchema` 时追加的 `## Final answer` 小节。
- [任务清单](/zh/sdk/behavior/tasks) —— 逐轮注入的任务列表 reminder。
- [Subagents](/zh/sdk/tools/subagents) —— 默认提示词展示的 subagent 列表。
- [快速上手](/zh/sdk/getting-started) —— 安装并运行你的第一个 agent。
