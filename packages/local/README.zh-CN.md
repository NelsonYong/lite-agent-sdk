# @lite-agent/local

[English](./README.md) | **简体中文**

lite-agent 的严格单机组装包：整合本地模型、SQLite WAL、强制 OS 沙箱、默认拒绝的托管权限、中断工具恢复、资源上限、二进制文件恢复，以及脱敏并带 hash chain 的本地事件日志。

## 安装

```bash
pnpm add @lite-agent/local zod
```

`better-sqlite3` 和 `@anthropic-ai/sandbox-runtime` 包含原生/运行时依赖。严格模式面向 macOS 和 Linux。

## 快速开始

```ts
import { createLocalAgent, localOpenAI } from "@lite-agent/local";

const agent = await createLocalAgent({
  model: localOpenAI({
    runtime: "ollama",
    contextWindow: 32_768,
    nativeTools: true, // 仅当所选模型确实支持 tool calling 时设置
  }),
  modelName: "qwen3:8b",
  workdir: process.cwd(),
});

const result = await agent.send("总结这个项目。");
console.log(result.text);
console.log(agent.diagnostics());
await agent.close();
```

`codec: "auto"` 只在 `nativeTools: true` 时使用原生工具调用，否则使用 `jsonCodec`；`reactCodec` 必须显式选择。

## 严格默认值

- Provider 必须声明 loopback/Unix socket endpoint，并通过启动健康检查。
- SQLite 使用 WAL、`synchronous=FULL`、完整性检查和安全的中断工具恢复。
- Bash 禁止出网、过滤环境变量、强制初始化沙箱，并限制前台墙钟/CPU 120 秒、后台墙钟 30 分钟、后台任务总数 4 个、进程树内存 2 GiB、128 个进程和 5 MiB 输出。
- 文件修改拒绝 symlink，使用原子替换，并在修改前持久化 UTF-8/base64 快照。
- 权限默认拒绝；只读内置工具默认允许，修改类工具必须显式配置 `ask` 或 `allow`。
- 未声明 `security` 的自定义工具拒绝注册；离线模式只接受 `network: "none" | "loopback"`。
- 事件默认脱敏，写入 10 MiB 轮转的 SHA-256 chain；设置 `LITE_AGENT_AUDIT_KEY` 后使用 HMAC。

运行数据位于 SDK 项目目录下，包括 `sessions.sqlite3` 和 `logs/events.jsonl`。

## 权限文件

加载顺序：托管文件（`LITE_AGENT_MANAGED_PERMISSIONS`）、用户文件（`~/.lite-agent/permissions.json`）、项目文件（`.lite-agent/permissions.json`）、内联规则。全局 deny-wins，因此托管 deny 无法被覆盖。

```json
{
  "version": 1,
  "rules": [
    { "id": "edit-src", "tool": ["write_file", "edit_file"], "when": { "path": { "glob": "src/**" } }, "effect": "allow" },
    { "id": "review-bash", "tool": "bash", "effect": "ask" }
  ]
}
```

使用 `queryAudit()` 查询结构化权限决策，或用 `exportAudit()` 导出 NDJSON。权限文件发生变化时自动重载；损坏更新会 fail-closed。

## 本地运行时

`localOpenAI` 内置 `ollama`、`vllm`、`lm-studio`、`llama.cpp` 的 loopback 预设。vLLM/llama.cpp 优先使用本地 tokenize endpoint；其他运行时使用注入 estimator，缺省采用保守的 bytes/3 估算，并在 `diagnostics()` 标为 approximate。
