/** Runtime data only. Configuration files and host-owned backends are not encoded. */
export interface AgentStorage {
  /** A directory-safe product namespace. Default `lite-agent`; directories use `.<namespace>`. */
  namespace?: string;
  /** Global data/config directory. Default `~/.<namespace>`. */
  home?: string;
  codec?: StorageCodec;
}

export interface StorageContext {
  readonly namespace: string;
  readonly projectId: string;
  /** Session id, task-list id, or project spill scope. Never a physical path. */
  readonly scopeId: string;
  readonly kind: "checkpoint" | "task" | "archive" | "archive-index" | "spill";
  readonly recordId: string;
}

export interface StorageCodec {
  /** Stable format/key version. Changing this requires an explicit data migration. */
  readonly id: string;
  encode(bytes: Uint8Array, context: Readonly<StorageContext>): Uint8Array | Promise<Uint8Array>;
  decode(bytes: Uint8Array, context: Readonly<StorageContext>): Uint8Array | Promise<Uint8Array>;
}

/** Options shared by the built-in file stores. */
export interface StorageEncoding {
  codec?: StorageCodec;
  namespace?: string;
  projectId?: string;
}

/** Deliberately excludes callback error messages, which may contain plaintext or keys. */
export class StorageError extends Error {
  constructor(message: string) { super(message); this.name = "StorageError"; }
}

export function validateStorageCodec(codec: StorageCodec): void {
  if (typeof codec.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(codec.id) ||
      typeof codec.encode !== "function" || typeof codec.decode !== "function")
    throw new StorageError("Invalid storage codec: provide a stable id and encode/decode functions");
}

// One envelope per record, so append-only logs remain append-only. No paths or
// plaintext previews are stored outside the codec payload.
export function storageEncoding(options: StorageEncoding = {}) {
  const supplied = options.codec;
  if (supplied) validateStorageCodec(supplied);
  const codec = supplied ? { id: supplied.id, encode: supplied.encode.bind(supplied), decode: supplied.decode.bind(supplied) } : undefined;
  const context = (kind: StorageContext["kind"], scopeId: string, recordId: string): StorageContext => Object.freeze({
    namespace: options.namespace ?? "lite-agent", projectId: options.projectId ?? "standalone", kind, scopeId, recordId,
  });
  return {
    context,
    async encode(text: string, ctx: StorageContext): Promise<string> {
      if (!codec) return text;
      let bytes: Uint8Array;
      try { bytes = await codec.encode(Buffer.from(text, "utf8"), ctx); }
      catch { throw new StorageError(`Storage encode failed (${ctx.kind})`); }
      if (!(bytes instanceof Uint8Array)) throw new StorageError("Storage encode must return Uint8Array");
      return JSON.stringify({ liteAgentStorage: 1, codec: codec.id, payload: Buffer.from(bytes).toString("base64") });
    },
    async decode(text: string, ctx: StorageContext): Promise<string> {
      let envelope: { liteAgentStorage?: unknown; codec?: unknown; payload?: unknown } | undefined;
      try { envelope = JSON.parse(text); } catch { /* Plain text archives need not be JSON. */ }
      if (!codec) {
        if (envelope && Object.hasOwn(envelope, "liteAgentStorage"))
          throw new StorageError("Encoded storage requires its configured codec");
        return text;
      }
      if (envelope?.liteAgentStorage !== 1 || envelope.codec !== codec.id || typeof envelope.payload !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.payload))
        throw new StorageError("Storage format or codec id mismatch; explicit migration is required");
      let bytes: Uint8Array;
      try { bytes = await codec.decode(Buffer.from(envelope.payload, "base64"), ctx); }
      catch { throw new StorageError(`Storage decode failed (${ctx.kind})`); }
      if (!(bytes instanceof Uint8Array)) throw new StorageError("Storage decode must return Uint8Array");
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new StorageError("Storage decode returned invalid UTF-8"); }
    },
  };
}
