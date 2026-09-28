# Storage and namespaces

`createLiteAgent({ storage })` configures the SDK's directories and encoding for built-in runtime persistence. It does not create another agent type or install a plugin framework.

## Build your own agent

```ts
import { createLiteAgent } from '@lite-agent/sdk';
import { anthropic } from '@lite-agent/provider';

const agent = createLiteAgent({
  model: anthropic(),
  workdir: process.cwd(),
  storage: {
    namespace: 'acme',
    // Optional: default is ~/.acme
    home: '/data/acme',
  },
});
```

One namespace controls global and project config discovery, skills, agent definitions, sessions, tasks and context archives. The root resolves the layout once; children inherit it. Changing the input object or environment later does not redirect a running family.

```text
<data home>/
  hooks.json
  mcps.json
  permissions.json
  skills/
  agents/
  projects/<project hash>/
    sessions/<session id>.jsonl
    sessions/<session id>.context/
    tasks/<task-list id>/
    spill/

<workdir>/.acme/
  hooks.json
  mcps.json
  permissions.json
  skills/
  agents/
```

| Option | Meaning |
| --- | --- |
| `storage.namespace` | Default `lite-agent`. Use 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter. The directory prefix `.` is added automatically. |
| `storage.home` | Global config/data directory; default `~/.<namespace>`. Relative paths resolve at root creation. It does not change `<workdir>/.<namespace>`. Use a distinct home for each product. |
| `storage.codec` | Optional synchronous or asynchronous `StorageCodec` for built-in runtime records. No encoding is enabled by default. |

The default namespace still honors `LITE_AGENT_HOME` and `LITE_AGENT_TASK_LIST_ID`. Custom namespaces ignore those variables: set `storage.home` and `taskListId` explicitly. The old top-level `home` is deprecated; conflicting `home` and `storage.home` values are rejected. There is no fallback scan of `.lite-agent` after selecting another namespace.

`hooks.json` and `mcps.json` are discovered automatically. Permission files remain opt-in through `permissionFilePolicy`; pass the same storage configuration:

```ts
import { permissionFilePolicy, resolveProjectPaths } from '@lite-agent/sdk';

const storage = { namespace: 'acme', home: '/data/acme' };
const workdir = process.cwd();
const permission = permissionFilePolicy({ workdir, storage, default: 'deny' });
const paths = resolveProjectPaths({ workdir, storage });
// paths.home / paths.projectConfigDir also configure your host sandbox.
```

Custom namespaces ignore `LITE_AGENT_MANAGED_PERMISSIONS`; use an explicit `managedFile`. Repository permission files may restrict host grants, never expand them.

## Encode and decode runtime data

`StorageCodec` receives UTF-8 bytes and immutable logical context. It returns bytes or a promise of bytes. For example, use Node's compression library:

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

// Pass storage: { namespace: 'acme', codec } to createLiteAgent.
```

Compression is not encryption. For encryption, use a mature authenticated encryption implementation; keep keys in host-owned secure storage. Bind the logical context as authenticated additional data, and include format/key version in `id`. A callback can await key retrieval. The SDK does not manage keys or execute codec code from JSON files.

`StorageContext` contains `namespace`, `projectId`, `scopeId`, `kind` and `recordId`. The scope is the session id, shared task-list id or project spill scope. `kind` is `checkpoint`, `task`, `archive`, `archive-index` or `spill`. No physical path is included, so moving the data home preserves the encoding context when the project path and logical identifiers stay the same.

| Encoded by the built-in stores | Outside this codec |
| --- | --- |
| Session events, checkpoint snapshots and audit payloads | `hooks.json`, `mcps.json`, `permissions.json`, skills and agent definitions |
| Task subjects, descriptions, dependencies and results | Project files, shell output files and host logs |
| Archive bodies, previews and metadata indexes | Host-injected `checkpointer` / legacy `store`, including SQLite |
| Legacy spill bodies | Model traffic and OAuth/key storage owned by the host |

Records use a versioned JSON envelope with a codec id and a base64 payload. Record filenames, sizes, modification times, codec ids and content references remain visible. The SDK does not claim to hide storage metadata. New runtime files use mode `0600`; temporary replacement files contain encoded bytes too.

Encoding completes before committing a checkpoint batch or a task dependency update. File locks remain held across async callbacks. Decode errors, mismatched codec ids and invalid UTF-8 fail explicitly as `StorageError`; callback messages are excluded to avoid leaking payloads or keys. An encoded decode failure never triggers tail repair, a plaintext retry or an empty-session fallback. Host callbacks must eventually settle; arbitrary JavaScript cannot be forcibly cancelled or sandboxed by this interface.

## Archives and permissions

Models retrieve archived data through `context({ ref, offset?, limit? })`. The SDK resolves the current session's reference, decodes it and applies the existing pagination and output budget. A reference is not a filesystem path or a grant to another session.

With a codec enabled, the SDK does not add its raw archive/log paths to `read_file`'s extra read roots. Use `context` to retrieve decoded content. Ordinary project permissions and host-supplied read roots still apply. A custom storage directory does not grant shell access to the data home; configure an OS sandbox separately.

Cleanup uses file age and size without decoding records or guessing their format. It skips active file locks and symlinks; an unfamiliar or damaged format is not deleted merely because it is unreadable. Existing retention settings still apply. `deleteSession` removes the session archive and private task list, while explicitly shared task lists remain.

Storage encoding protects the persisted representation only. Decoded data may still enter model requests; outbound privacy/redaction requires a separate model-call policy.

## Migration and low-level APIs

No automatic rename, format migration or key rotation occurs. Changing the namespace selects another project config directory and, unless `home` is explicit, another global home. Stop agents and back up data before moving it. Moving only `home` preserves project hashes; changing `workdir` changes the project hash.

Enabling a codec on existing plaintext data, removing a required codec or changing its id requires an explicit migration. Use the previous configuration to read the records and the new configuration to write a separate destination; preserve event order and archive scope. Do not overwrite the only copy. The SDK does not silently mix encoded and plaintext records.

`fileCheckpointer`, `fileTaskStore`, `fileContextArchive` and `fileSpillStore` accept `codec`, `namespace` and `projectId` when used directly. Set `sessionId` on a standalone archive to match the agent's session scope. `resolveProjectPaths()` supplies the project hash and directory layout.

Since SDK 0.18 / Core 0.17, await these low-level operations:

- `ContextArchive.put/search/read` and file spill reads/writes.
- `TaskStore.get/list/render`, as well as its existing `create/update` operations.
- `runPipeline()` and `CompactPass.apply()` results; passes and spill strategies can perform async persistence.

Normal `createLiteAgent`, `send`, `run` and `query` usage is unchanged. A custom `Checkpointer` retains responsibility for its own serialization and transactional guarantees; `storage.codec` is not applied around it.

Built-in file session and task-list ids must be nonempty letters, digits, underscores or hyphens. Invalid ids are rejected instead of being rewritten to colliding filenames; host-provided backends can define other id rules.
