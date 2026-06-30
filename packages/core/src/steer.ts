import type { Message } from "./types";

/** Inject user input into a running agent at turn boundaries (mirrors AbortController). */
export class SteerController {
  private _steers: Message[] = [];
  private _followUps: Message[] = [];

  /** Add input applied before the next model turn. */
  steer(content: string | Message): void {
    this._steers.push(typeof content === "string" ? { role: "user", content } : content);
  }
  /** Add input that continues a run which would otherwise stop. */
  followUp(content: string | Message): void {
    this._followUps.push(typeof content === "string" ? { role: "user", content } : content);
  }
  /** Kernel-internal: take and clear queued steers. */
  takeSteers(): Message[] { const s = this._steers; this._steers = []; return s; }
  /** Kernel-internal: take and clear queued follow-ups. */
  takeFollowUps(): Message[] { const f = this._followUps; this._followUps = []; return f; }
}
