import {
  AgentError,
  backgroundCompletionMessage,
  createBackgroundTasks,
} from "@lite-agent/core";
import type {
  AgentEvent,
  BackgroundLimits,
  BackgroundTasks,
  Message,
  RunOptions,
  RunResult,
} from "@lite-agent/core";

export interface LiteAgentEvent {
  sessionId: string;
  source: "user" | "background";
  event: AgentEvent;
}

export type SessionRun<R extends RunResult> = (
  input: string | Message[],
  opts: RunOptions & { sessionId: string },
) => AsyncGenerator<AgentEvent, R>;

export interface SessionRunner<R extends RunResult> {
  bind(run: SessionRun<R>): void;
  run(
    input: string | Message[],
    opts: RunOptions & { sessionId: string },
  ): AsyncGenerator<AgentEvent, R>;
  backgroundTasks(sessionId: string): BackgroundTasks | undefined;
  subscribe(listener: (entry: LiteAgentEvent) => void): () => void;
  awaitIdle(sessionId: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface SessionRunnerOptions {
  background: boolean;
  limits?: BackgroundLimits;
  waitForBackgroundIdle?: (sessionId: string) => Promise<void>;
  onBackgroundCompletion?: (sessionId: string, label: string) => void;
  onSessionCancel?: (sessionId: string) => void;
}

export function createSessionRunner<R extends RunResult>(
  opts: SessionRunnerOptions,
): SessionRunner<R> {
  type Scope = {
    active: boolean;
    abort: AbortController;
    tasks: BackgroundTasks;
    draining: boolean;
    completion?: Promise<void>;
  };

  const scopes = new Map<string, Scope>();
  const tails = new Map<string, Promise<void>>();
  const scheduled = new Map<string, Scope>();
  const listeners = new Set<(entry: LiteAgentEvent) => void>();
  const idleWaiters = new Map<string, Set<() => void>>();
  let execute: SessionRun<R> | undefined;
  let closed = false;

  const wakeIdleWaiters = (sessionId: string) => {
    const waiters = idleWaiters.get(sessionId);
    if (!waiters) return;
    idleWaiters.delete(sessionId);
    for (const resolve of waiters) resolve();
  };

  const runnerIdle = (sessionId: string) => {
    const scope = scopes.get(sessionId);
    return !tails.has(sessionId) &&
      !scheduled.has(sessionId) &&
      !scope?.draining &&
      !scope?.completion &&
      !scope?.tasks.hasCompleted();
  };

  const waitForRunnerChange = (sessionId: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const waiters = idleWaiters.get(sessionId) ?? new Set<() => void>();
      const done = () => {
        waiters.delete(done);
        if (waiters.size === 0) idleWaiters.delete(sessionId);
        resolve();
      };
      waiters.add(done);
      idleWaiters.set(sessionId, waiters);
      if (closed || runnerIdle(sessionId)) done();
    });

  const publish = (entry: LiteAgentEvent) => {
    if (closed) return;
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // Listeners are observational and cannot fail session work.
      }
    }
  };

  const acquire = async (sessionId: string): Promise<() => void> => {
    const previous = tails.get(sessionId) ?? Promise.resolve();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const tail = previous.then(() => gate);
    tails.set(sessionId, tail);
    await previous;
    return () => {
      open();
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
      wakeIdleWaiters(sessionId);
    };
  };

  const requireExecute = (): SessionRun<R> => {
    if (closed) throw new AgentError("LiteAgent is closed");
    if (!execute) throw new AgentError("LiteAgent session runner is not bound");
    return execute;
  };

  const drain = async (
    sessionId: string,
    source: LiteAgentEvent["source"],
    input: string | Message[],
    runOpts: RunOptions,
  ): Promise<R> => {
    const generator = requireExecute()(input, { ...runOpts, sessionId });
    let next = await generator.next();
    try {
      while (!next.done) {
        publish({ sessionId, source, event: next.value });
        next = await generator.next();
      }
      return next.value;
    } finally {
      if (!next.done) await generator.return(undefined as unknown as R);
    }
  };

  const runCompletions = async (sessionId: string, scope: Scope) => {
    const release = await acquire(sessionId);
    try {
      if (closed || !scope.active || scopes.get(sessionId) !== scope) return;
      scope.draining = true;
      const completions = scope.tasks.takeCompleted();
      if (completions.length === 0) return;
      for (const completion of completions) {
        publish({
          sessionId,
          source: "background",
          event: { type: "background_completed", completion },
        });
        opts.onBackgroundCompletion?.(sessionId, completion.label);
      }
      await drain(
        sessionId,
        "background",
        completions.map(backgroundCompletionMessage),
        { signal: scope.abort.signal },
      );
    } finally {
      scope.draining = false;
      // Clear completion state before waking idle waiters so the wake observes
      // one coherent settled snapshot instead of requiring another turn.
      if (scope.completion) scope.completion = undefined;
      release();
      if (scheduled.get(sessionId) === scope) scheduled.delete(sessionId);
      if (!closed && scope.active && scope.tasks.hasCompleted()) schedule(sessionId, scope);
      wakeIdleWaiters(sessionId);
    }
  };

  const schedule = (sessionId: string, scope: Scope) => {
    if (closed || !scope.active || scheduled.get(sessionId) === scope) return;
    scheduled.set(sessionId, scope);
    wakeIdleWaiters(sessionId);
    const completion = runCompletions(sessionId, scope);
    scope.completion = completion;
    void completion.catch((error) => {
      const agentError = error instanceof AgentError
        ? error
        : new AgentError(error instanceof Error ? error.message : String(error));
      publish({
        sessionId,
        source: "background",
        event: { type: "error", error: agentError, fatal: true },
      });
    }).finally(() => {
      wakeIdleWaiters(sessionId);
    });
  };

  const backgroundTasks = (sessionId: string): BackgroundTasks | undefined => {
    if (!opts.background || closed) return undefined;
    const existing = scopes.get(sessionId);
    if (existing) return existing.tasks;
    const abort = new AbortController();
    let scope!: Scope;
    const tasks = createBackgroundTasks({
      emit: (event) => publish({ sessionId, source: "background", event }),
      signal: abort.signal,
      limits: opts.limits,
      onCompleted: () => schedule(sessionId, scope),
    });
    scope = { active: true, abort, tasks, draining: false };
    scopes.set(sessionId, scope);
    return tasks;
  };

  const cancelSession = async (sessionId: string) => {
    const scope = scopes.get(sessionId);
    if (!scope) return;
    scope.active = false;
    scopes.delete(sessionId);
    opts.onSessionCancel?.(sessionId);
    scope.abort.abort();
    scope.tasks.cancelAll();
    if (scope.draining && scope.completion) await scope.completion;
    wakeIdleWaiters(sessionId);
  };

  return {
    bind(run) {
      if (execute) throw new AgentError("LiteAgent session runner is already bound");
      execute = run;
    },
    run(input, runOpts) {
      const sessionId = runOpts.sessionId;
      return (async function* () {
        const release = await acquire(sessionId);
        let generator: AsyncGenerator<AgentEvent, R> | undefined;
        let next: IteratorResult<AgentEvent, R> | undefined;
        try {
          generator = requireExecute()(input, { ...runOpts, sessionId });
          next = await generator.next();
          while (!next.done) {
            publish({ sessionId, source: "user", event: next.value });
            yield next.value;
            next = await generator.next();
          }
          return next.value;
        } finally {
          if (generator && next && !next.done) {
            await generator.return(undefined as unknown as R);
          }
          release();
        }
      })();
    },
    backgroundTasks,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async awaitIdle(sessionId) {
      while (!closed) {
        await opts.waitForBackgroundIdle?.(sessionId);
        if (runnerIdle(sessionId)) return;
        const completion = scopes.get(sessionId)?.completion;
        if (completion) {
          await completion;
          continue;
        }
        await waitForRunnerChange(sessionId);
      }
    },
    cancelSession,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...scopes.keys()].map(cancelSession));
      for (const sessionId of [...idleWaiters.keys()]) wakeIdleWaiters(sessionId);
      listeners.clear();
    },
  };
}
