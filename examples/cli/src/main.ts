import { config } from "dotenv";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { sandboxRuntime } from "@lite-agent/sandbox-anthropic";
import { createLiteAgent, policy } from "@lite-agent/sdk";
import type {
  AgentEvent,
  ApprovalHandler,
  InputHandler,
  UserAnswer,
  UserQuestion,
} from "@lite-agent/sdk";
import { modelConfiguration, resolveModel } from "./model.js";

// Resolve this example's own root (examples/cli) so its .env + skills/ load
// regardless of where you launch it from (independent of process.cwd()).
const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(exampleRoot, ".env") });

// The agent operates on the directory you launch it from.
const workdir = process.cwd();

// During a run, stdin is in raw mode with a single 'data' listener (onKey). While an
// approval is pending, that listener routes the keypress here instead of ESC-aborting.
let pendingApproval: ((decision: "allow" | "deny") => void) | null = null;

const onApproval: ApprovalHandler = {
  request: (call, signal) =>
    new Promise((resolve) => {
      process.stdout.write(
        `\n\x1b[33m[approve] ${call.name} ${JSON.stringify(call.input)}? [y/N] \x1b[0m`,
      );
      const abort = () => {
        pendingApproval = null;
        resolve("deny");
      };
      pendingApproval = (decision) => {
        signal?.removeEventListener("abort", abort);
        resolve(decision);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    }),
};

// A line being typed in response to ask_user. onKey accumulates bytes into `buffer`
// (raw mode, so we echo + handle backspace ourselves) and resolves on Enter.
let pendingInput: { buffer: string; resolve: (text: string) => void } | null =
  null;

function parseAnswer(q: UserQuestion, text: string): UserAnswer {
  const t = text.trim();
  if (q.options && q.options.length) {
    const picked = t
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10) - 1)
      .filter((n) => Number.isInteger(n) && q.options![n] !== undefined)
      .map((n) => q.options![n]!);
    if (picked.length)
      return q.multiSelect ? { selected: picked } : { selected: [picked[0]!] };
  }
  return { text: t };
}

const onAskUser: InputHandler = {
  request: (q, signal) =>
    new Promise((resolve) => {
      process.stdout.write(`\n\x1b[36m[ask] ${q.question}\x1b[0m\n`);
      if (q.options && q.options.length) {
        q.options.forEach((o, i) => process.stdout.write(`  ${i + 1}. ${o}\n`));
        process.stdout.write(
          `\x1b[90m(number${q.multiSelect ? "s, comma-separated," : ""} or free text)\x1b[0m > `,
        );
      } else {
        process.stdout.write("> ");
      }
      const abort = () => { pendingInput = null; resolve({ text: "" }); };
      pendingInput = {
        buffer: "",
        resolve: (text) => {
          signal?.removeEventListener("abort", abort);
          resolve(parseAnswer(q, text));
        },
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    }),
};

const { provider, modelName, protocol } = resolveModel();
process.stdout.write(`\x1b[90m[model] ${modelName} via ${protocol}\x1b[0m\n`);

const agent = createLiteAgent({
  ...modelConfiguration({ provider, modelName, protocol }),
  workdir,
  skillsDir: join(exampleRoot, "skills"),
  permission: policy({ ask: ["bash", "write_file", "edit_file", "delete_file"] }),
  onApproval,
  onAskUser,
  // OS-level boundary (defense-in-depth with the permission gate). macOS=Seatbelt, Linux=bubblewrap.
  // Fail closed: installing the sandbox is a prerequisite for this shell-capable demo.
  sandbox: sandboxRuntime({
    requireSandbox: true,
    allowedDomains: [
      "registry.npmjs.org",
      "api.github.com",
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
    ],
    denyRead: ["~/.ssh", "~/.aws"],

  }),
});

process.stdout.write(`\x1b[90m[session] ${agent.sessionId}\x1b[0m\n`);

function render(ev: AgentEvent): void {
  switch (ev.type) {
    case "compaction": {
      const count = ev.completed !== undefined && ev.total !== undefined ? ` ${ev.completed}/${ev.total}` : "";
      const tokens = ev.phase === "done" ? ` ${ev.before} → ${ev.after} tokens` : "";
      process.stdout.write(`\n[compact] ${ev.phase ?? ev.kind} ${ev.stage ?? ""}${count}${tokens}${ev.message ? `: ${ev.message}` : ""}\n`);
      break;
    }
    case "checkpoint_restore":
      process.stdout.write(`\n[restore] ${ev.phase} ${ev.completed}/${ev.total}${ev.message ? `: ${ev.message}` : ""}\n`);
      break;
    case "model_call_start":
      process.stdout.write(`\n[${ev.agentId ?? "main"}] model=${ev.model} reasoning=${ev.reasoningEffort ?? "provider default"}\n`);
      break;
    case "task_update":
      process.stdout.write(`\n[task ${ev.taskId}] ${ev.status}${ev.owner ? ` @${ev.owner}` : ""}\n`);
      break;
    case "text_delta":
      process.stdout.write(ev.text);
      break;
    case "tool_use":
      process.stdout.write(
        `\n\x1b[32m[tool] ${ev.call.name} ${JSON.stringify(ev.call.input)}\x1b[0m\n`,
      );
      break;
    case "tool_result": {
      const body =
        ev.result.content.length > 500
          ? `${ev.result.content.slice(0, 500)}…`
          : ev.result.content;
      process.stdout.write(`\x1b[90m${body}\x1b[0m\n`);
      break;
    }
    case "approval_resolved":
      process.stdout.write(
        ev.decision === "allow"
          ? "\x1b[32m[approved]\x1b[0m\n"
          : "\x1b[31m[denied]\x1b[0m\n",
      );
      break;
    case "error":
      process.stdout.write(`\n\x1b[31m[error] ${ev.error.message}\x1b[0m\n`);
      break;
    case "done":
      process.stdout.write("\n");
      break;
    default:
      break;
  }
}

function readPrompt(rl: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolvePromise) => {
    const lines: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let multiline = false;

    const submit = () => {
      rl.removeListener("line", onLine);
      resolvePromise(lines.join("\n"));
    };
    const onLine = (line: string) => {
      if (multiline) {
        if (line === "") submit();
        else {
          lines.push(line);
          process.stdout.write("\x1b[90m...  \x1b[0m");
        }
        return;
      }
      if (timer) clearTimeout(timer);
      lines.push(line);
      timer = setTimeout(() => {
        if (lines.length > 1) {
          multiline = true;
          process.stdout.write(
            "\x1b[90m[multi-line: blank line submits]\x1b[0m\n\x1b[90m...  \x1b[0m",
          );
        } else {
          submit();
        }
      }, 50);
    };

    process.stdout.write("\x1b[36mlite-agent >> \x1b[0m");
    rl.on("line", onLine);
  });
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const unsubscribe = agent.subscribe(({ sessionId, event }) => {
    if (sessionId === agent.sessionId) render(event);
  });

  try {
  while (true) {
    const text = (await readPrompt(rl)).trim();
    if (!text) continue;
    if (["q", "exit"].includes(text.toLowerCase())) break;

    // Session-management commands are handled locally (never sent to the model).
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      try {
        if (cmd === "sessions") {
          const list = await agent.listSessions();
          if (!list.length) process.stdout.write("\x1b[90m(no sessions)\x1b[0m\n");
          for (const s of list)
            process.stdout.write(`  ${s.id}\t${new Date(s.mtime).toLocaleString()}\n`);
        } else if (cmd === "resume") {
          if (!arg) process.stdout.write("\x1b[31musage: /resume <id>\x1b[0m\n");
          else {
            agent.resume(arg);
            process.stdout.write(`\x1b[90m[session] ${agent.sessionId}\x1b[0m\n`);
          }
        } else if (cmd === "compact") {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          rl.on("SIGINT", cancel);
          try { for await (const _ of agent.compact(arg || undefined, { signal: controller.signal })) { /* subscribe renders progress */ } }
          finally { rl.removeListener("SIGINT", cancel); }
        } else if (cmd === "checkpoints") {
          const checkpoints = await agent.listCheckpoints(agent.sessionId);
          if (!checkpoints.length) process.stdout.write("[checkpoints] no user checkpoints yet\n");
          for (const cp of checkpoints) {
            process.stdout.write(`  ${cp.seq}\t${new Date(cp.ts).toLocaleString()}\t${cp.prompt.slice(0, 100)}\t${cp.files.length} files${cp.unavailableFiles.length ? `; unavailable: ${cp.unavailableFiles.join(", ")}` : ""}\n`);
          }
        } else if (cmd === "restore") {
          if (!/^\d+$/u.test(rest[0] ?? "") || rest.length > 2 || (rest[1] && rest[1] !== "--conversation-only"))
            throw new Error("usage: /restore <checkpoint-seq> [--conversation-only]");
          await agent.restore(agent.sessionId, Number(rest[0]), { files: rest[1] !== "--conversation-only" });
        } else if (cmd === "clear") {
          process.stdout.write(`\x1b[90m[session] ${agent.clear()} (new)\x1b[0m\n`);
        } else if (cmd === "delete") {
          if (!arg) process.stdout.write("\x1b[31musage: /delete <id>\x1b[0m\n");
          else {
            await agent.deleteSession(arg);
            process.stdout.write(`\x1b[90m[deleted] ${arg}\x1b[0m\n`);
          }
        } else {
          process.stdout.write(`\x1b[31munknown command: /${cmd}\x1b[0m\n`);
        }
      } catch (e) {
        process.stdout.write(`\n\x1b[31m[error] ${(e as Error).message}\x1b[0m\n`);
      }
      continue;
    }

    const ac = new AbortController();
    rl.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (key: Buffer) => {
      if (pendingApproval) {
        const resolve = pendingApproval;
        pendingApproval = null;
        const ch = key.toString();
        const allow = ch === "y" || ch === "Y";
        process.stdout.write("\n");
        resolve(allow ? "allow" : "deny");
        return;
      }
      if (pendingInput) {
        const b = key[0];
        if (b === 0x0d || b === 0x0a) {
          const { resolve, buffer } = pendingInput;
          pendingInput = null;
          process.stdout.write("\n");
          resolve(buffer);
        } else if (b === 0x7f || b === 0x08) {
          if (pendingInput.buffer.length) {
            pendingInput.buffer = pendingInput.buffer.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (b !== 0x1b) {
          const ch = key.toString();
          pendingInput.buffer += ch;
          process.stdout.write(ch);
        }
        return;
      }
      if (key[0] === 0x1b && key.length === 1) {
        ac.abort();
        process.stdout.write("\n\x1b[33m[ESC] interrupted\x1b[0m\n");
      }
    };
    process.stdin.on("data", onKey);

    try {
      // Server-side history: send only the new turn; the kernel reloads the
      // session's transcript from the store via the agent's current sessionId.
      const gen = agent.run([{ role: "user", content: text }], { signal: ac.signal });
      let r = await gen.next();
      while (!r.done) {
        r = await gen.next();
      }
    } catch (e) {
      process.stdout.write(`\n\x1b[31m[error] ${(e as Error).message}\x1b[0m\n`);
    } finally {
      pendingApproval = null;
      pendingInput = null;
      process.stdin.removeListener("data", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.resume();
    }
  }
  } finally {
    unsubscribe();
    await agent.close();
    rl.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
