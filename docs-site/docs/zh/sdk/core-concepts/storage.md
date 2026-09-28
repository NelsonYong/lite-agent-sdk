# 存储与命名空间

`createLiteAgent({ storage })` 统一配置 SDK 的目录，以及内置运行数据的持久化编码。它不引入另一种 agent，也不要求安装插件框架。

## 构建自己的 Agent

```ts
import { createLiteAgent } from '@lite-agent/sdk';
import { anthropic } from '@lite-agent/provider';

const agent = createLiteAgent({
  model: anthropic(),
  workdir: process.cwd(),
  storage: {
    namespace: 'acme',
    // 可选，默认 ~/.acme
    home: '/data/acme',
  },
});
```

命名空间统一控制全局和项目配置发现、skills、agent 定义、会话、任务和上下文归档。根 agent 只解析一次目录，子 agent 继承；运行后修改输入配置或环境变量，不会把同一组 agent 重定向到其他目录。

```text
<数据主目录>/
  hooks.json
  mcps.json
  permissions.json
  skills/
  agents/
  projects/<项目哈希>/
    sessions/<会话 ID>.jsonl
    sessions/<会话 ID>.context/
    tasks/<任务列表 ID>/
    spill/

<workdir>/.acme/
  hooks.json
  mcps.json
  permissions.json
  skills/
  agents/
```

| 配置 | 含义 |
| --- | --- |
| `storage.namespace` | 默认 `lite-agent`。1–64 位小写字母、数字、下划线或连字符，以字母开头；目录前面的 `.` 自动添加。 |
| `storage.home` | 全局配置与数据目录，默认 `~/.<namespace>`。相对路径在根 agent 创建时解析；不会改变 `<workdir>/.<namespace>`。不同产品应使用独立 home。 |
| `storage.codec` | 可选的同步或异步 `StorageCodec`，作用于内置运行数据。默认不启用编码。 |

默认命名空间仍读取 `LITE_AGENT_HOME` 和 `LITE_AGENT_TASK_LIST_ID`。自定义命名空间忽略这些变量，请显式配置 `storage.home` 和 `taskListId`。旧的顶层 `home` 已弃用；与 `storage.home` 冲突时直接报错。选择其他命名空间后，不会回退扫描 `.lite-agent`。

`hooks.json` 和 `mcps.json` 自动发现。权限文件仍需通过 `permissionFilePolicy` 显式启用，并传入同一份存储配置：

```ts
import { permissionFilePolicy, resolveProjectPaths } from '@lite-agent/sdk';

const storage = { namespace: 'acme', home: '/data/acme' };
const workdir = process.cwd();
const permission = permissionFilePolicy({ workdir, storage, default: 'deny' });
const paths = resolveProjectPaths({ workdir, storage });
// paths.home / paths.projectConfigDir 也可用于配置宿主沙箱。
```

自定义命名空间忽略 `LITE_AGENT_MANAGED_PERMISSIONS`，可显式传入 `managedFile`。仓库权限文件只能进一步限制宿主授权，不能扩大权限。

## 编码与解码运行数据

`StorageCodec` 接收 UTF-8 字节及只读的逻辑上下文，返回字节或字节的 Promise。例如，直接复用 Node 压缩库：

```ts
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import type { StorageCodec } from '@lite-agent/sdk';

const compress = promisify(gzip);
const decompress = promisify(gunzip);

const codec: StorageCodec = {
  id: 'gzip-v1',
  async encode(bytes, context) {
    return compress(bytes);
  },
  async decode(bytes, context) {
    return decompress(bytes);
  },
};

// 创建 agent 时传入 storage: { namespace: 'acme', codec }。
```

压缩不等于加密。如果需要加密，请使用成熟的认证加密实现，由宿主安全存储密钥；把逻辑上下文作为附加认证数据，并在 `id` 中体现格式／密钥版本。回调可以等待密钥获取。SDK 不管理密钥，也不会从 JSON 配置加载并执行编码器代码。

`StorageContext` 包含 `namespace`、`projectId`、`scopeId`、`kind` 和 `recordId`。scope 对应会话 ID、共享任务列表 ID 或项目 spill 范围；kind 为 `checkpoint`、`task`、`archive`、`archive-index` 或 `spill`。其中不包含物理路径：项目路径和逻辑标识保持不变时，移动 home 不会改变编码上下文。

| 内置存储经过编码的内容 | 不受此 codec 管理的内容 |
| --- | --- |
| 会话事件、checkpoint 快照、审计事件载荷 | `hooks.json`、`mcps.json`、`permissions.json`、skills 和 agent 定义 |
| 任务主题、描述、依赖、执行结果 | 项目文件、Shell 输出文件、宿主日志 |
| 归档正文、预览、元数据索引 | 宿主注入的 `checkpointer`／旧版 `store`，包括 SQLite |
| 旧版 spill 正文 | 模型请求及宿主管理的 OAuth／密钥存储 |

记录使用带版本、codec ID 和 base64 载荷的 JSON 封装。文件名、大小、修改时间、codec ID 和内容引用仍然可见，SDK 不承诺隐藏这些存储元数据。新建运行数据文件使用 `0600` 权限；原子替换的临时文件也只写编码后的字节。

checkpoint 批次和任务依赖更新先完成全部编码，再提交写入；文件锁覆盖异步回调。解码失败、codec ID 不匹配、非法 UTF-8 会明确抛出 `StorageError`，不会透出可能包含原文或密钥的回调错误消息。编码记录的解码错误不会触发尾部修复、明文重试或空会话回退。宿主回调必须最终完成；此接口无法强制取消或隔离任意 JavaScript。

## 归档与权限

模型通过 `context({ ref, offset?, limit? })` 读取归档。SDK 验证引用属于当前会话、读取并解码，再应用现有的分页和输出预算。引用不是文件系统路径，也不是读取其他会话的授权。

启用 codec 时，SDK 不会把归档／日志的原始路径加入 `read_file` 的额外读取范围，应使用 `context` 获取解码后的内容。普通项目权限和宿主显式提供的 read roots 仍然有效。自定义存储目录不会自动给 Shell 授予访问权限；操作系统隔离仍由宿主沙箱提供。

清理按文件年龄和大小工作，不执行解码器、不猜测文件格式，并跳过活动文件锁和符号链接。无法识别或损坏的格式不会仅因“读不懂”就被删除；原有保留时长及容量配置仍然生效。`deleteSession` 删除该会话归档和私有任务列表，显式共享的任务列表保留。

存储编码只保护落盘表示，解码后的数据仍可能进入模型请求。远端模型脱敏需要另行实现模型请求出口策略。

## 迁移与底层 API

SDK 不自动重命名目录、转换格式或轮换密钥。修改 namespace 会选择新的项目配置目录；未显式指定 home 时，全局目录也随之改变。移动数据前停止相关 agent 并备份。只移动 home 不会改变项目哈希；修改 workdir 会改变项目哈希。

对已有明文启用 codec、移除原有 codec 或修改其 ID，都需要显式迁移：用旧配置读取数据、用新配置写入另一个目标位置，保留事件顺序和归档 scope，不覆盖唯一副本。SDK 不会静默混读明文与编码记录。

直接使用 `fileCheckpointer`、`fileTaskStore`、`fileContextArchive`、`fileSpillStore` 时，可传入 `codec`、`namespace` 和 `projectId`。独立创建归档时还应设置 `sessionId`，使其与 agent 的会话范围一致。`resolveProjectPaths()` 提供项目哈希和目录布局。

从 SDK 0.18 / Core 0.17 开始，底层调用需要等待：

- `ContextArchive.put/search/read` 及文件 spill 的读写。
- `TaskStore.get/list/render`，以及原本已经异步的 `create/update`。
- `runPipeline()` 和 `CompactPass.apply()` 的结果；压缩步骤及 spill 策略允许执行异步持久化。

日常 `createLiteAgent`、`send`、`run` 和 `query` 的使用方式不变。自定义 `Checkpointer` 继续负责自己的序列化和事务保证，SDK 不会在外面暗中叠加 `storage.codec`。

内置文件会话和任务列表 ID 必须非空，且仅含字母、数字、下划线或连字符。非法 ID 会被拒绝，不再重写成可能碰撞的文件名；宿主自定义后端可定义其他 ID 规则。
