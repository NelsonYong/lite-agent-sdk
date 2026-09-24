# MCP 服务器

从 `@lite-agent/sdk` 0.16.0 起，MCP 与内置工具共用权限、Hook、并发、取消和上下文归档机制。依赖官方 `@modelcontextprotocol/client` 2.1.0，明确固定 **MCP 2026-07-28**，要求 Node.js >=20。支持 stdio 和 Streamable HTTP；不支持旧服务器、旧 SSE 传输或协议自动降级。

## 推荐接入方式

持久配置放在项目 `<workdir>/.lite-agent/mcps.json`，个人通用配置放在 `<home>/mcps.json`（默认 `~/.lite-agent/mcps.json`）：

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://docs.example.com/mcp"
    },
    "files": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"],
      "env": { "LOG_LEVEL": "warn" }
    }
  }
}
```

包装键与 Claude 的 `mcpServers` 对齐，但文件名是 lite-agent 的 **mcps.json**。不会读取 Claude 设置或根目录 `.mcp.json`。`stdio` 的 `type` 可以省略；`http` 必须显式声明。配置不支持变量插值，凭证推荐由宿主从环境读取后通过构造参数/实例传入，不要提交到项目文件。

`createLiteAgent()` 只读取并校验配置，不启动服务器。首次 `run()` / `send()` 会在请求模型前完成连接授权、发现及校验。没有 MCP 配置时不会连接任何服务器。

```ts
import { createLiteAgent } from '@lite-agent/sdk';
import { openai } from '@lite-agent/provider';
import { policy } from '@lite-agent/core';

const agent = createLiteAgent({
  workdir: process.cwd(),
  model: openai(),
  modelName: 'your-model',
  // 不自动信任项目文件中声明的服务器；由宿主 UI 实现审批。
  onApproval: { request: (call, signal) => requestHostApproval(call, signal) },
  permission: policy({
    ask: ['mcp_connect', 'mcp__*', 'bash', 'write_file', 'edit_file', 'delete_file', 'hook'],
  }),
});

try {
  console.log((await agent.send('通过 docs 查询项目文档')).text);
} finally {
  await agent.close();
}
```

`requestHostApproval` 是应用自行提供的审批函数，返回 `Promise<'allow' | 'deny'>`。默认策略本身也会询问连接及每次 MCP 调用；缺少处理器则拒绝。`allowedTools` 只控制可见工具，不能替代权限策略。

## 代码配置与实例注册

三种入口共用一个注册表：文件、`mcpServers` 构造参数和 `agent.mcp`。

```ts
const agent = createLiteAgent({
  workdir: process.cwd(),
  model,
  strictMcpConfig: true, // 忽略全局/项目文件，只使用显式配置
  mcpServers: {
    docs: { type: 'http', url: 'https://docs.example.com/mcp' },
  },
  onApproval,
});

try {
  // register 返回时已完成授权、连接、发现及原子注册。
  await agent.mcp.register('search', {
    type: 'http',
    url: 'https://search.example.com/mcp',
    headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
    timeoutMs: 30_000,
  });
  console.log(agent.mcp.list()); // 本地状态、来源、工具名；不联网，不返回凭证
  await agent.send('搜索资料');
  await agent.awaitIdle();
  await agent.mcp.unregister('search'); // 关闭连接；不修改配置文件
} finally {
  await agent.close();
}
```

不同名称合并；规范化后完全一致的配置去重；同名不同配置报错，不隐式覆盖。实例重复注册也报错。替换须先 `unregister` 再 `register`。配置在构造时读取，不热加载。

只有根 agent 可修改注册表，且根和关联工作都必须空闲；Hook 内调用会立即拒绝。子 agent 共享连接，保留自己的工具白名单和更严格的权限，关闭子 agent 不关闭根连接。`close()` 取消活动任务，回收自有客户端、订阅和直接子进程。

## 工具、事件与失败

工具名为 `mcp__<server>__<tool>`，例如 `mcp__docs__search`。服务器别名限 1–24 个字母、数字、下划线或连字符，不能含 `__`；完整工具名限 64 个相同字符。无效名称、重名和无效 schema 使整个候选注册失败，释放连接。

- 每次运行固定工具目录。服务器通知工具变化或连接失效后，目录标记 `stale`；空闲时重新注销/注册，重新授权。运行中不会悄悄替换 schema。
- 输入使用官方 JSON Schema 校验，输出按服务器声明的 output schema 校验。`isError` 保留为工具错误；文本、资源链接和 `structuredContent`（包括标量）保存在 JSON 投影中。
- 超过 16 KiB 的投影及媒体/嵌入资源存入会话归档，模型只接收 `context({ref, offset})` 引用。远程 `file://` URI 不会成为宿主文件读取权限，也不会自动打开链接。
- `tool_progress` 事件包含 `id`、`name`、`progress`、可选 `total` / `message`，通过 `run()` 或 `subscribe()` 实时接收。现有 `tool:start` / `tool:end` Hook 同样覆盖 MCP 工具。
- 连接和调用默认超时 30 秒，可设置 `timeoutMs`（1–300000 毫秒）。取消使用现有 `AbortSignal`。断线、超时和取消可能意味着执行结果未知，SDK 不自动重放有副作用的调用。

上限：32 台服务器、每台 128 个工具、16 页发现结果、512 KiB 工具目录、256 KiB 配置文件、4 MiB stdio 消息/HTTP 响应/工具投影。超限明确失败；HTTP 字节在协议解析前受限。

## 安全与支持边界

连接使用独立能力 `mcp_connect`；调用使用具体工具名。配置文件不授予执行权，服务器的只读/idempotent 注解也不用于自动授权。服务器 instructions 不会注入系统提示词。连接权限始终强制执行，即使工具权限配置了 dry-run。

普通 SDK 的 stdio 使用已有 `sandbox`（若提供）；未配置沙箱时，经批准的进程以宿主权限运行。环境继承采用官方传输的安全默认集合，加显式 `env`，不传递整个 `process.env`。stderr 被消费但不写日志。不要把密钥放在命令参数中。

`createLocalAgent()` 只允许自身启动的 stdio，并使用强制 OS 沙箱和资源限制；即使 HTTP 指向 localhost 也拒绝。SDK home 和项目 `.lite-agent` 对这些进程禁止读取/写入，归档读取仍由 SDK 自身的会话工具完成。

官方 2.1.0 的固定协议 stdio 会先运行一次临时探测进程，再启动实际进程；两次使用同一沙箱命令。服务器启动应避免业务副作用。官方传输负责直接子进程关闭；任意孙进程回收仍依赖操作系统隔离环境。

远程 URL 必须 HTTPS，回环 `localhost` / `127.0.0.1` / `[::1]` 可用 HTTP；拒绝 URL 用户凭证、片段、保留协议请求头和重定向。本版支持显式 HTTP headers；暂不提供 OAuth 登录/令牌续期、外部 Client 注入、资源/提示词自动加载、sampling、roots、elicitation 或自动 `input_required` 处理。

## Core 工具接口变化

`Tool.schema` 现在使用 Standard Schema 校验及 Standard JSON Schema 的输入导出接口；Zod 4 工具继续可用。泛型 `Tool` 消费者应使用 `schema['~standard'].validate(input)`，不要假定所有 schema 都有 Zod 的 `.parse()`。`Tool.execute()` 可返回字符串或 `{ content: string, isError?: boolean }`；直接调用工具时需区分两种返回值。
