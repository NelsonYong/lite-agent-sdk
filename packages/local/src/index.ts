import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  jsonCodec, nativeCodec, reactCodec,
} from "@lite-agent/core";
import type {
  AgentEvent, Message, PermissionRule, Redactor, RunOptions, StoredEvent,
  TokenEstimator, ToolCallCodec,
} from "@lite-agent/core";
import {
  createLiteAgent, jsonlEventSink, permissionFilePolicy, resolveProjectPaths,
} from "@lite-agent/sdk";
import type {
  CreateLiteAgentConfig, EventSink, FilePermissionPolicy, LiteAgent, LiteAgentResult,
} from "@lite-agent/sdk";
import { sqliteCheckpointer } from "@lite-agent/checkpoint-sqlite";
import { sandboxRuntime } from "@lite-agent/sandbox-anthropic";
import type { SandboxRuntimeOptions } from "@lite-agent/sandbox-anthropic";
import {
  DEFAULT_RESOURCE_LIMITS, probeResourceLimits, resourceLimitedSandbox,
} from "./resources";
import type { ResourceLimits } from "./resources";
import { isLoopbackEndpoint } from "./provider";
import type { LocalModelProvider } from "./provider";

export { localOpenAI, markLocalProvider, isLoopbackEndpoint } from "./provider";
export type {
  LocalModelProvider, LocalOpenAIOptions, LocalProviderCapabilities, LocalRuntime,
} from "./provider";
export { DEFAULT_RESOURCE_LIMITS, probeResourceLimits, resourceLimitedSandbox } from "./resources";
export type { ResourceLimits } from "./resources";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const BASE_RULES: PermissionRule[] = [
  { id: "builtin-read", tool: ["read_file", "read_spilled", "load_skill", "TaskGet", "TaskList", "BashOutput"], effect: "allow" },
  { id: "builtin-input", tool: ["ask_user", "final_answer"], effect: "allow" },
];

type StrictOmissions =
  | "model" | "codec" | "sandbox" | "checkpointer" | "store" | "sessions"
  | "permissionAudit" | "fileTools" | "bash" | "crashRecovery"
  | "maxSnapshotBytesPerSession" | "backgroundLimits" | "cleanup" | "contextBudget"
  | "permission" | "subagentPermission" | "permissionMode" | "redact";

export interface LocalAgentConfig extends Omit<CreateLiteAgentConfig, StrictOmissions> {
  model: LocalModelProvider;
  modelName: string;
  codec?: "auto" | "native" | "json" | "react" | ToolCallCodec;
  resources?: Partial<ResourceLimits>;
  sandboxOptions?: Omit<
    SandboxRuntimeOptions,
    | "requireSandbox" | "allowedDomains" | "allowWrite" | "allowRead"
    | "allowLocalBinding" | "allowUnixSockets" | "allowAllUnixSockets"
    | "enableWeakerNestedSandbox" | "enableWeakerNetworkIsolation" | "allowAppleEvents"
  >;
  environment?: Record<string, string>;
  permissionFiles?: {
    managed?: string | false;
    user?: string | false;
    project?: string | false;
    inlineRules?: PermissionRule[];
  };
  eventSink?: EventSink | false;
  eventRedactor?: Redactor;
  auditKey?: string | Buffer;
}

export interface LocalDiagnostics {
  provider: { endpoint: string; runtime: string; nativeTools: boolean; contextWindow: number };
  codec: "native" | "json" | "react" | "custom";
  tokenizer: "exact" | "approximate";
  sandbox: { id: string; required: true; hardResourceLimits: boolean };
  persistence: { file: string; integrity: { ok: boolean; detail: string } };
  permissions: ReturnType<FilePermissionPolicy["status"]>;
  trace: { enabled: boolean; file?: string; integrity: "sha256" | "hmac-sha256" | "custom" };
}

export type PermissionAuditEntry = StoredEvent & {
  event: Extract<StoredEvent["event"], { type: "permission_decision" }>;
};

export interface LocalAgent extends LiteAgent {
  diagnostics(): LocalDiagnostics;
  queryAudit(opts?: { sessionId?: string; sinceSeq?: number; tool?: string; decision?: "allow" | "deny" | "ask" }): Promise<PermissionAuditEntry[]>;
  exportAudit(opts?: Parameters<LocalAgent["queryAudit"]>[0]): AsyncGenerator<string>;
  close(): Promise<void>;
}

const approximateEstimator: TokenEstimator = (messages) =>
  Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 3);

function chooseCodec(
  selected: LocalAgentConfig["codec"],
  nativeTools: boolean,
): { codec: ToolCallCodec; name: LocalDiagnostics["codec"] } {
  if (selected && typeof selected === "object") return { codec: selected, name: "custom" };
  const name = selected === "auto" || selected === undefined ? (nativeTools ? "native" : "json") : selected;
  if (name === "native") return { codec: nativeCodec(), name };
  if (name === "react") return { codec: reactCodec(), name };
  return { codec: jsonCodec(), name: "json" };
}

function strictEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

export async function createLocalAgent(cfg: LocalAgentConfig): Promise<LocalAgent> {
  if (!cfg.model.local || !isLoopbackEndpoint(cfg.model.local.endpoint))
    throw new Error("strict local mode requires a declared loopback or Unix-socket provider");
  if (!Number.isFinite(cfg.model.local.contextWindow) || cfg.model.local.contextWindow <= 0)
    throw new Error("local provider contextWindow must be a positive finite number");
  for (const tool of cfg.tools ?? []) {
    if (!tool.security) throw new Error(`custom tool '${tool.name}' is missing security metadata`);
    if (tool.security.network !== "none" && tool.security.network !== "loopback")
      throw new Error(`custom tool '${tool.name}' is not offline-safe (${tool.security.network})`);
  }
  await cfg.model.local.probe?.();

  const paths = resolveProjectPaths({ workdir: cfg.workdir, home: cfg.home });
  const workdir = resolve(cfg.workdir);
  const projectDir = dirname(paths.sessionsDir);
  mkdirSync(projectDir, { recursive: true });
  const databaseFile = join(projectDir, "sessions.sqlite3");
  const traceFile = join(projectDir, "logs", "events.jsonl");
  const checkpointer = sqliteCheckpointer({
    file: databaseFile, synchronous: "full", busyTimeoutMs: 5000, integrityCheckOnOpen: true,
  });
  const runtimeSandbox = sandboxRuntime({
    ...cfg.sandboxOptions,
    requireSandbox: true,
    allowedDomains: [],
    allowWrite: [workdir],
    denyRead: ["~/.ssh", "~/.aws", "~/.config", ...(cfg.sandboxOptions?.denyRead ?? [])],
  });
  const resourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...cfg.resources };
  const sandbox = resourceLimitedSandbox(runtimeSandbox, resourceLimits);
  const usingDefaultSink = cfg.eventSink === undefined;
  let sink: EventSink | undefined;
  try {
    sink = cfg.eventSink === false
      ? undefined
      : cfg.eventSink ?? jsonlEventSink({
          file: traceFile, maxBytes: 10 * MIB, maxFiles: 5,
          redactor: cfg.eventRedactor, integrityKey: cfg.auditKey ?? process.env.LITE_AGENT_AUDIT_KEY,
        });
  } catch (error) {
    checkpointer.close();
    throw error;
  }
  const cleanupFailedStart = async () => {
    await Promise.allSettled([
      sink?.close() ?? Promise.resolve(),
      Promise.resolve().then(() => checkpointer.close()),
      Promise.resolve().then(() => sandbox.dispose?.()),
    ]);
  };
  try {
    await sandbox.initialize?.();
  } catch (error) {
    await cleanupFailedStart();
    throw error;
  }

  const pendingDiagnostics: AgentEvent[] = [];
  let permissionFiles: FilePermissionPolicy;
  try {
    permissionFiles = permissionFilePolicy({
      workdir: cfg.workdir,
      home: paths.home,
      managedFile: cfg.permissionFiles?.managed,
      userFile: cfg.permissionFiles?.user,
      projectFile: cfg.permissionFiles?.project,
      inlineRules: cfg.permissionFiles?.inlineRules,
      baseRules: BASE_RULES,
      default: "deny",
      onReload: (status) => {
        pendingDiagnostics.push({
          type: "diagnostic",
          level: status.error ? "error" : "info",
          code: status.error ? "permission_reload_failed" : "permission_reloaded",
          message: status.error ?? `Loaded ${status.files.length} permission file(s)`,
        });
      },
    });
  } catch (error) {
    await cleanupFailedStart();
    throw error;
  }
  const selectedCodec = chooseCodec(cfg.codec, cfg.model.local.nativeTools);
  const estimator: TokenEstimator = cfg.model.local.tokenEstimator
    ?? (cfg.model.local.tokenize
      ? (messages) => cfg.model.local.tokenize!(cfg.modelName, messages)
      : approximateEstimator);
  const outputBudget = cfg.maxTokens ?? Math.min(4096, Math.floor(cfg.model.local.contextWindow * 0.25));
  const inputBudget = cfg.model.local.contextWindow - outputBudget - Math.floor(cfg.model.local.contextWindow * 0.1);
  if (inputBudget <= 0) {
    await cleanupFailedStart();
    throw new Error("local contextWindow is too small for the configured output budget");
  }

  let base: LiteAgent;
  try {
    base = createLiteAgent({
      ...cfg,
      model: cfg.model,
      modelName: cfg.modelName,
      codec: selectedCodec.codec,
      maxTokens: outputBudget,
      maxDecodeRetries: cfg.maxDecodeRetries ?? 2,
      checkpointer,
      sandbox,
      permission: permissionFiles,
      subagentPermission: permissionFiles,
      permissionMode: "enforce",
      permissionAudit: true,
      redact: cfg.eventRedactor,
      fileTools: { symlinks: "inside", maxSnapshotBytes: MIB, atomicWrites: true },
      bash: {
        timeoutMs: 120_000,
        backgroundTimeoutMs: 30 * 60_000,
        maxOutputBytes: 5 * MIB,
        memoryBytes: resourceLimits.memoryBytes,
        env: strictEnvironment(cfg.environment),
        security: { network: "none", filesystem: "workspace", sideEffects: "workspace" },
      },
      crashRecovery: "safe",
      maxSnapshotBytesPerSession: 64 * MIB,
      backgroundLimits: {
        maxTotal: 4, maxJoinable: 4, maxDetached: 4,
        bufferBytes: MIB, maxTaskMs: 30 * 60_000,
      },
      cleanup: { maxAgeDays: 30, maxBytes: GIB },
      contextBudget: { maxTokens: inputBudget, estimator },
    });
  } catch (error) {
    await cleanupFailedStart();
    throw error;
  }

  let closed = false;
  type ActiveRun = {
    base: AsyncGenerator<AgentEvent, LiteAgentResult>;
    wrapped: AsyncGenerator<AgentEvent, LiteAgentResult>;
    controller: AbortController;
    started: boolean;
    done: Promise<void>;
    finish(): void;
    removeOuterListener(): void;
  };
  const activeRuns = new Set<ActiveRun>();
  const run = (input: string | Message[], opts?: RunOptions): AsyncGenerator<AgentEvent, LiteAgentResult> => {
    if (closed) throw new Error("local agent is closed");
    const sessionId = opts?.sessionId ?? base.sessionId;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(opts?.signal?.reason);
    if (opts?.signal?.aborted) onOuterAbort();
    else opts?.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const stream = base.run(input, { ...opts, signal: controller.signal });
    let resolveDone!: () => void;
    const active = {} as ActiveRun;
    active.base = stream;
    active.controller = controller;
    active.started = false;
    active.done = new Promise<void>((resolveDonePromise) => { resolveDone = resolveDonePromise; });
    active.finish = () => { resolveDone(); };
    active.removeOuterListener = () => opts?.signal?.removeEventListener("abort", onOuterAbort);
    const wrapped = (async function* () {
      active.started = true;
      const emitPending = async function* () {
        while (pendingDiagnostics.length) {
          const event = pendingDiagnostics.shift()!;
          await sink?.write(sessionId, event);
          yield event;
        }
      };
      try {
        yield* emitPending();
        let next = await stream.next();
        while (!next.done) {
          yield* emitPending();
          await sink?.write(sessionId, next.value);
          yield next.value;
          next = await stream.next();
        }
        yield* emitPending();
        return next.value;
      } finally {
        activeRuns.delete(active);
        active.removeOuterListener();
        try { await stream.return(undefined as never); }
        finally { active.finish(); }
      }
    })();
    active.wrapped = wrapped;
    activeRuns.add(active);
    return wrapped;
  };
  const local: LocalAgent = {
    run,
    subscribe: (listener) => base.subscribe(listener),
    async send(input, opts) {
      const stream = run(input, opts);
      let next = await stream.next();
      while (!next.done) next = await stream.next();
      return next.value;
    },
    get sessionId() { return base.sessionId; },
    resume: (id) => base.resume(id),
    clear: () => base.clear(),
    deleteSession: (id) => base.deleteSession(id),
    listSessions: () => base.listSessions(),
    listCheckpoints: (id) => base.listCheckpoints(id),
    restore: (id, seq, opts) => base.restore(id, seq, opts),
    compact(instructions) {
      const stream = base.compact(instructions);
      return (async function* () {
        let next = await stream.next();
        while (!next.done) {
          await sink?.write(base.sessionId, next.value);
          yield next.value;
          next = await stream.next();
        }
        return next.value;
      })();
    },
    diagnostics: () => ({
      provider: {
        endpoint: cfg.model.local.endpoint,
        runtime: cfg.model.local.runtime ?? "custom",
        nativeTools: cfg.model.local.nativeTools,
        contextWindow: cfg.model.local.contextWindow,
      },
      codec: selectedCodec.name,
      tokenizer: cfg.model.local.tokenizerAccuracy ?? (cfg.model.local.tokenEstimator || cfg.model.local.tokenize ? "exact" : "approximate"),
      sandbox: { id: sandbox.id, required: true, hardResourceLimits: true },
      persistence: { file: databaseFile, integrity: checkpointer.checkIntegrity() },
      permissions: permissionFiles.status(),
      trace: {
        enabled: sink !== undefined,
        ...(sink && usingDefaultSink ? { file: traceFile } : {}),
        integrity: !sink || !usingDefaultSink
          ? "custom"
          : cfg.auditKey || process.env.LITE_AGENT_AUDIT_KEY ? "hmac-sha256" : "sha256",
      },
    }),
    async queryAudit(opts = {}) {
      const id = opts.sessionId ?? base.sessionId;
      const out: PermissionAuditEntry[] = [];
      for await (const stored of checkpointer.read(id, { sinceSeq: opts.sinceSeq })) {
        if (stored.event.type !== "permission_decision") continue;
        if (opts.tool && stored.event.call.name !== opts.tool) continue;
        if (opts.decision && stored.event.decision !== opts.decision) continue;
        out.push(stored as PermissionAuditEntry);
      }
      return out;
    },
    async *exportAudit(opts) {
      for (const entry of await local.queryAudit(opts)) yield `${JSON.stringify(entry)}\n`;
    },
    async close() {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      const runs = [...activeRuns];
      for (const active of runs) active.controller.abort(new Error("local agent closed"));
      const stopped = await Promise.allSettled(runs.map(async (active) => {
        if (!active.started) {
          try {
            await active.wrapped.return(undefined as never);
            await active.base.return(undefined as never);
          }
          finally {
            activeRuns.delete(active);
            active.removeOuterListener();
            active.finish();
          }
          return;
        }
        await Promise.allSettled([
          active.wrapped.return(undefined as never),
          active.done,
        ]);
      }));
      for (const result of stopped) if (result.status === "rejected") errors.push(result.reason);
      activeRuns.clear();
      try { await base.close(); } catch (error) { errors.push(error); }
      try { await sink?.close(); } catch (error) { errors.push(error); }
      try { checkpointer.close(); } catch (error) { errors.push(error); }
      try { await sandbox.dispose?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "failed to close local agent cleanly");
    },
  };
  return local;
}
