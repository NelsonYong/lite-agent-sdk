import type { Middleware } from "@lite-agent/core";
import type { TaskStore } from "./types";

// Re-injects the current task list as a trailing <system-reminder> into the
// model request ONLY. wrapModelCall mutates ctx.messages just before encode and
// restores it in `finally`, so the reminder is never pushed onto the transcript
// or persisted.
//
// MUST be innermost (last in the middleware array) for TWO reasons:
//  1. codec.encode reads ctx.messages at call time, so the reminder must be
//     appended as close to encode as possible.
//  2. It is a correctness requirement w.r.t. an outer wrapModelCall like
//     reactiveCompaction: on a 413 retry, this `finally` must restore
//     ctx.messages BEFORE the outer middleware trims it. If taskReminder were
//     OUTER, its `finally` would overwrite (discard) the reactive trim, so the
//     overflow would recur instead of being recovered.
export function taskReminder(store: TaskStore): Middleware {
  return {
    name: "task-reminder",
    async *wrapModelCall(ctx, next) {
      const block = store.render();
      if (!block) {
        yield* next();
        return;
      }
      const saved = ctx.messages;
      ctx.messages = [
        ...saved,
        { role: "user", content: `<system-reminder>\nCurrent tasks:\n${block}\n</system-reminder>` },
      ];
      try {
        yield* next();
      } finally {
        ctx.messages = saved;
      }
    },
  };
}
