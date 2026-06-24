import type { Middleware } from "@lite-agent/core";
import type { TaskStore } from "./types";

// Re-injects the current task list as a trailing <system-reminder> into the
// model request ONLY. wrapModelCall mutates ctx.messages just before encode and
// restores it in `finally`, so the reminder is never pushed onto the transcript
// or persisted. Place it innermost (last in the middleware array) so it sits
// closest to codec.encode.
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
