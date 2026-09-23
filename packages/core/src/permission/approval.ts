import type { ApprovalHandler } from "../strategies";

import { abortable } from "../channel";

function untilAbort(promise: Promise<"allow" | "deny">, signal?: AbortSignal): Promise<"allow" | "deny"> {
  return abortable(promise, signal).catch((error) => {
    if (signal?.aborted) return "deny";
    throw error;
  });
}

/** A shared, cancellable approval queue; a late answer cannot authorize an aborted call. */
export function serialApproval(handler: ApprovalHandler): ApprovalHandler {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request(call, signal) {
      const next = tail.then(() => signal?.aborted ? "deny" as const : untilAbort(
        Promise.resolve().then(() => signal?.aborted ? "deny" as const : handler.request(call, signal)), signal,
      ));
      tail = next.then(() => undefined, () => undefined);
      // A queued call can be cancelled without waiting for the active prompt.
      return untilAbort(next, signal);
    },
  };
}
