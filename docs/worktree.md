# worktree.ts 详解

## 概述

`worktree.ts` 实现了基于 **git worktree** 的任务隔离机制，解决多个 teammate 并发修改同一代码库时的文件冲突问题。每个任务可以绑定一个独立的 worktree 目录，在隔离的分支上工作，完成后通过 PR 合并。

模块包含两个核心类：
- **EventBus** — JSONL 事件日志，记录 worktree 生命周期事件
- **WorktreeManager** — git worktree 的创建、查询、执行、删除等完整生命周期管理

整体架构：

```
┌────────────┐     worktree_create    ┌──────────────────┐
│  Lead /    │ ──────────────────────▶│  WorktreeManager │
│  Teammate  │     worktree_run       │                  │
│            │ ──────────────────────▶│  .worktrees/     │
│            │     worktree_remove    │    index.json    │
│            │ ──────────────────────▶│    events.jsonl  │
└────────────┘                        │    task-1/  ←─── git worktree 目录
                                      │    task-2/       │
                                      └──────────────────┘
                                             │
                                      ┌──────┴───────┐
                                      │   git repo   │
                                      │  共享 .git   │
                                      └──────────────┘
```

---

## 目录结构

| 路径 | 用途 |
|------|------|
| `.worktrees/` | worktree 管理根目录 |
| `.worktrees/index.json` | worktree 索引，记录所有 worktree 的元数据 |
| `.worktrees/events.jsonl` | 事件日志，记录所有 worktree 操作 |
| `.worktrees/{name}/` | 具体的 git worktree 目录（独立工作副本） |

---

## 核心类型定义

### WorktreeEntry

```ts
{
  name: string;                              // worktree 名称（唯一标识）
  path: string;                              // 磁盘路径
  branch: string;                            // 关联的 git 分支（wt/{name}）
  task_id: number | null;                    // 绑定的任务 ID
  status: "active" | "removed" | "kept";     // 状态
  created_at: number;                        // 创建时间戳
  removed_at?: number;                       // 删除时间戳
  kept_at?: number;                          // 标记保留时间戳
}
```

### WorktreeEvent

```ts
{
  event: string;                    // 事件名称（如 worktree.create.after）
  ts: number;                       // 时间戳
  task: Record<string, unknown>;    // 关联的任务信息
  worktree: Record<string, unknown>; // worktree 信息
  error?: string;                   // 错误信息（失败时）
}
```

---

## 类详解

### 1. EventBus

JSONL 格式的事件日志，用于追踪 worktree 的完整生命周期。

#### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `emit` | `(event, task?, worktree?, error?) → void` | 追加一条事件到日志文件 |
| `listRecent` | `(limit?) → string` | 返回最近 N 条事件（默认 20，最大 200） |

#### 事件类型

| 事件名 | 触发时机 |
|--------|----------|
| `worktree.create.before` | 创建 worktree 之前 |
| `worktree.create.after` | 创建成功之后 |
| `worktree.create.failed` | 创建失败时 |
| `worktree.remove.after` | 删除成功之后 |
| `worktree.remove.failed` | 删除失败时 |
| `worktree.keep` | 标记为保留时 |

---

### 2. WorktreeManager

管理 git worktree 的完整生命周期。

#### 初始化

```ts
const REPO_ROOT = detectRepoRoot(process.cwd());
const EVENTS = new EventBus(join(REPO_ROOT, ".worktrees", "events.jsonl"));
const WORKTREES = new WorktreeManager(REPO_ROOT, EVENTS);
```

`detectRepoRoot` 通过 `git rev-parse --show-toplevel` 定位仓库根目录，非 git 仓库时回退到 `cwd()`。

#### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `create` | `(name, taskId?, baseRef?) → string` | 创建 worktree，自动建分支 `wt/{name}` |
| `listAll` | `() → string` | 列出所有 worktree 及其状态 |
| `status` | `(name) → string` | 返回指定 worktree 的 `git status` |
| `run` | `(name, command) → string` | 在 worktree 目录中执行 shell 命令 |
| `remove` | `(name, force?, completeTask?) → string` | 删除 worktree |
| `keep` | `(name) → string` | 标记 worktree 为保留状态（不自动清理） |
| `getPath` | `(name) → string \| null` | 获取 worktree 的磁盘路径 |

#### create 流程

```
create("task-1", taskId=1, baseRef="HEAD")
  │
  ├─ 1. 校验名称（仅允许 [A-Za-z0-9._-]，最长 40 字符）
  ├─ 2. 检查是否已存在同名 worktree
  ├─ 3. emit("worktree.create.before")
  ├─ 4. git worktree add -b wt/task-1 .worktrees/task-1 HEAD
  ├─ 5. 写入 index.json
  ├─ 6. emit("worktree.create.after")
  └─ 7. 返回 WorktreeEntry JSON
```

#### 状态流转

```
create → active
keep   → kept      （标记保留，不被自动清理）
remove → removed   （物理删除 worktree 目录，索引保留记录）
```

#### 安全机制

- **命令过滤**：`run` 方法过滤危险命令（`rm -rf /`、`sudo`、`shutdown` 等）
- **路径校验**：执行前检查 worktree 路径是否存在
- **超时控制**：git 命令 120 秒超时，`run` 命令 300 秒超时
- **输出限制**：命令输出截断到 50KB

---

## Lead 侧工具（WORKTREE_SCHEMA）

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `worktree_create` | 创建 git worktree | `name`, `task_id?`, `base_ref?` |
| `worktree_list` | 列出所有 worktree | 无 |
| `worktree_status` | 查看 worktree 的 git 状态 | `name` |
| `worktree_run` | 在 worktree 中执行命令 | `name`, `command` |
| `worktree_remove` | 删除 worktree | `name`, `force?`, `complete_task?` |
| `worktree_keep` | 标记 worktree 为保留 | `name` |
| `worktree_events` | 查看最近的 worktree 事件 | `limit?` |

---

## 与 Task 的关联

worktree 通过 `task_id` 与任务系统关联。典型工作流：

```
1. task_create("重构 config 模块")           → task #1
2. worktree_create("refactor-config", task_id=1) → 创建隔离目录
3. task_bind_worktree(task_id=1, worktree="refactor-config")
4. worktree_run("refactor-config", "npm test")  → 在隔离目录执行
5. worktree_run("refactor-config", "git add . && git commit -m 'refactor config'")
6. worktree_remove("refactor-config", complete_task=true)
```

这样两个 teammate 可以同时处理不同任务，各自在独立 worktree 中工作，互不干扰：

```
Teammate A → .worktrees/refactor-config/   (分支 wt/refactor-config)
Teammate B → .worktrees/fix-auth/          (分支 wt/fix-auth)
主仓库     → ./                            (分支 master)
```

---

## 完整交互示例

### 示例 1：创建 worktree 并执行任务

```
Lead 调用:
  task_create("重构用户模块")
  → 创建 task #1

  worktree_create("user-refactor", task_id=1)
  → git worktree add -b wt/user-refactor .worktrees/user-refactor HEAD
  → index.json 记录新条目
  → events.jsonl 记录 worktree.create.after

  worktree_run("user-refactor", "ls src/user/")
  → 在 .worktrees/user-refactor/ 目录下执行
  → 返回文件列表

  worktree_status("user-refactor")
  → 返回 git status（修改了哪些文件）
```

### 示例 2：完成后清理

```
Lead 调用:
  worktree_run("user-refactor", "git add . && git commit -m 'refactor user module'")
  → 在 worktree 中提交

  worktree_remove("user-refactor", complete_task=true)
  → git worktree remove .worktrees/user-refactor
  → index.json 中状态改为 "removed"
  → task #1 可标记为 completed
```

### 示例 3：保留 worktree

```
Lead 调用:
  worktree_keep("user-refactor")
  → 状态改为 "kept"
  → 不会被自动清理，保留供后续使用
```

---

## 导出

```ts
export const WORKTREE_SCHEMA = [...];  // Lead 侧工具定义（7 个）
export { WORKTREES, EVENTS, REPO_ROOT };
```

- `WORKTREE_SCHEMA`：供主 Agent 注册 worktree 工具
- `WORKTREES`：WorktreeManager 单例
- `EVENTS`：EventBus 单例
- `REPO_ROOT`：检测到的 git 仓库根目录
