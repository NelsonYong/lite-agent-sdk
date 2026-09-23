/** Minimal push channel: push values, iterate them async, end to finish. */
import { AbortError } from "./events";

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new AbortError()); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(err?: Error): void;
}

export function channel<T>(): Channel<T> {
  const buf: T[] = [];
  let resolve: (() => void) | null = null;
  let done = false;
  let error: Error | undefined;
  const wake = () => { if (resolve) { const r = resolve; resolve = null; r(); } };
  return {
    push(value) { if (!done) { buf.push(value); wake(); } },
    end(err) { if (!done) { done = true; error = err; wake(); } },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (buf.length) yield buf.shift()!;
        if (done) { if (error) throw error; return; }
        await new Promise<void>((r) => { resolve = r; });
      }
    },
  };
}

/** Stream progress while a promise runs; consumer cancellation aborts its work. */
export async function* streamOperation<E, R>(
  run: (emit: (event: E) => void, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): AsyncGenerator<E, R> {
  const controller = new AbortController();
  const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const events = channel<E>();
  let result!: R;
  const task = Promise.resolve().then(() => run(events.push, linked));
  const settled = task.then((value) => { result = value; events.end(); }, (error) => {
    events.end(error instanceof Error ? error : new Error(String(error)));
  });
  try {
    yield* events;
    await settled;
    return result;
  } finally {
    controller.abort();
    await settled;
  }
}
