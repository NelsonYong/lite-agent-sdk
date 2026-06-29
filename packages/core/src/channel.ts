/** Minimal push channel: push values, iterate them async, end to finish. */
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
