# MCP 接入实现与调研记录

日期：2026-09-24。本次在工作区实现 Core / SDK 0.16.0、Local 0.4.0；尚未发布。API 使用方法及完整边界见 [中文接入文档](../docs-site/docs/zh/sdk/tools/mcp.md) 和 [英文接入文档](../docs-site/docs/en/sdk/tools/mcp.md)。真机脚本、临时服务及报告保存在代理独立工作目录，不进入仓库。

## 依赖与协议选择

使用官方 `@modelcontextprotocol/client` 2.1.0，官方 server 仅为测试依赖。独立适配模块放在 `packages/sdk/src/mcp/`，暂不新增公开包，降低安装与发布成本。Core 不依赖 MCP。

协议明确固定 `2026-07-28`，不降级、不实现旧 SSE、不自行实现 JSON-RPC、协议协商、stdio framing、SSE 解析、分页、订阅或 JSON Schema 转换。不能依赖官方默认值：2.1.0 的默认连接模式仍为 legacy，导出的 `LATEST_PROTOCOL_VERSION` 仍是 `2025-11-25`。

调研比较过旧 `@modelcontextprotocol/sdk` v1、`@ai-sdk/mcp` 和 `@langchain/mcp-adapters`。直接采用官方 v2 独立客户端，避免引入另一套 agent/provider/tool 抽象。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `mcp/config.ts` | 全局/项目文件发现、格式与大小验证、重名冲突、来源 |
| `mcp/registry.ts` | 根实例所有权、连接授权、事务式注册、活动运行租约、失效状态与关闭 |
| `mcp/connection.ts` | 官方 Client/Transport、最新协议、工具适配、进度/取消、归档投影 |
| `mcp/http.ts` | HTTP 重定向拒绝和解析前响应字节限制 |
| `liteAgentAssembly.ts` | 按下一次运行刷新工具及上下文前缀，应用父/子白名单 |
| `liteAgent.ts` | `agent.mcp`、与会话维护锁及 Hook 重入保护对接 |
| Core | Standard Schema 校验/导出、有效参数授权、结构化执行状态和通用进度事件 |
| Local | 仅受管 stdio、强制沙箱/资源限制、保护 SDK 自有存储 |

## 单一注册表

入口为 `<home>/mcps.json`（默认 `~/.lite-agent/mcps.json`）、`<workdir>/.lite-agent/mcps.json`、构造参数 `mcpServers`、`agent.mcp.register(name, config)`。包装键沿用 Claude 的 `mcpServers`，文件名按 lite-agent 的约定；不读取 Claude 私有设置。`strictMcpConfig` 忽略文件。

同步构造不联网、不启动进程。首次运行前完成全部待连接服务器的授权和发现；批次失败回收本批连接，不发布半个目录。实例注册返回时已原子发布，失败不留下条目。不同名称合并；完全相同配置去重；同名不同配置拒绝。替换必须显式注销/注册。

会话维护锁拒绝根任务及后台任务期间的修改，共享运行租约同时覆盖子 agent。一个子 agent 关闭不会销毁共享连接；根关闭负责回收。不同会话等待同一初始化，取消单个等待者不会清除其他会话仍在使用的初始化任务。

外部 catalog 通知或连接异常将工具目录标记 stale，运行中不更换 schema，后续调用拒绝。空闲时重新注销/注册以发现和授权新目录。

## 调用与安全边界

```text
配置快照 → mcp_connect 权限 → 官方协议发现 → 有界工具目录和 schema 校验
→ 下一运行的固定工具快照 → 模型调用 → Standard Schema 有效参数
→ 现有 Hook / 权限 / 并发链 → 官方 callTool(signal, timeout, onprogress)
→ 保留 isError 和 JSON 数据 → 大内容/媒体会话归档 → tool:end / tool_result
```

默认连接和调用都询问；缺少审批处理器时拒绝。连接权限不受工具 dry-run 放宽。服务器注解不作为安全证明，服务器 instructions 不注入提示词。不开放 sampling/roots/elicitation 或自动 input_required，不自动读取 resources/prompts。当前认证是宿主显式提供 HTTP headers，不实现 OAuth 引导/续期，也不接收外部 Client。

HTTP 除回环开发地址外必须 HTTPS，拒绝重定向、URL 用户凭证/片段和保留协议头。限制单响应字节后交由官方传输解析。stdio 使用官方安全环境默认值加显式 env、现有沙箱包装和官方直接子进程关闭策略；stderr 消费但不记录。普通 SDK 没有配置 sandbox 时仍是宿主权限进程，需明确审批；Local 强制隔离，并拒绝包括 loopback 在内的 HTTP。

远程 `file://` 仅是数据，不授予宿主读取权限。MCP 不因 SDK 自己可读 session 而获得整个 `.lite-agent` 存储权限。Local 的进程读写边界明确禁止 SDK home 和项目 `.lite-agent`，SDK 的会话引用读取不受此影响。

断线、取消、超时的副作用结果可能未知。没有自动调用重放或 exactly-once 承诺。官方固定协议 stdio 会启动临时探测和正式服务两个进程，两者使用同一受限命令；不能承诺任意孙进程都由 transport 回收。

## 验证方式

仓库内回归覆盖配置合并与拒绝、授权前无连接、最新协议路径、注册/卸载、输入及输出校验、业务错误、大结果归档、进度/取消、关闭、白名单、父子所有权、重入与目录失效。Core 回归验证异步 Standard Schema 和转换后有效参数授权。

仓库外真机验收使用官方服务端的真实 stdio 进程和 loopback HTTP，以及已授权模型端点的低并发调用。验收报告记录实际结果，不能将 in-process fetch 测试描述为外部网络或真实模型验证。

## 官方资料

- https://github.com/modelcontextprotocol/typescript-sdk
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md
- https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.md
- https://ts.sdk.modelcontextprotocol.io/v2/clients/calling.md
- https://ts.sdk.modelcontextprotocol.io/v2/advanced/schema-libraries.md
- https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices.md
- https://code.claude.com/docs/en/mcp
- https://platform.claude.com/docs/en/agent-sdk/typescript
