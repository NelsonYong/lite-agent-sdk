import { config } from "dotenv";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { anthropic } from "@lite-agent/provider-anthropic";
import { sandboxRuntime } from "@lite-agent/sandbox-anthropic";
import { createLiteAgent, policy } from "@lite-agent/sdk";
import type { AgentEvent, ApprovalHandler, InputHandler, Message, UserAnswer, UserQuestion } from "@lite-agent/sdk";

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
  request: (call) =>
    new Promise((resolve) => {
      process.stdout.write(
        `\n\x1b[33m[approve] ${call.name} ${JSON.stringify(call.input)}? [y/N] \x1b[0m`,
      );
      pendingApproval = resolve;
    }),
};

// A line being typed in response to ask_user. onKey accumulates bytes into `buffer`
// (raw mode, so we echo + handle backspace ourselves) and resolves on Enter.
let pendingInput: { buffer: string; resolve: (text: string) => void } | null = null;

function parseAnswer(q: UserQuestion, text: string): UserAnswer {
  const t = text.trim();
  if (q.options && q.options.length) {
    const picked = t
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10) - 1)
      .filter((n) => Number.isInteger(n) && q.options![n] !== undefined)
      .map((n) => q.options![n]!);
    if (picked.length) return q.multiSelect ? { selected: picked } : { selected: [picked[0]!] };
  }
  return { text: t };
}

const onAskUser: InputHandler = {
  request: (q) =>
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
      pendingInput = { buffer: "", resolve: (text) => resolve(parseAnswer(q, text)) };
    }),
};

const agent = createLiteAgent({
  model: anthropic(),
  modelName: process.env["MODEL_ID"],
  workdir,
  skillsDir: join(exampleRoot, "skills"),
  permission: policy({ ask: ["bash", "write_file", "edit_file"] }),
  onApproval,
  onAskUser,
  // OS-level boundary (defense-in-depth with the permission gate). macOS=Seatbelt, Linux=bubblewrap.
  // Degrades to noop on unsupported envs so bash keeps working.
  sandbox: sandboxRuntime({
    allowedDomains: [
      "registry.npmjs.org",
      "api.github.com",
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
    ],
    denyRead: ["~/.ssh", "~/.aws"],
    onUnavailable: (err) =>
      process.stdout.write(
        `\x1b[33m[sandbox] unavailable — running without OS boundary: ${err.message}\x1b[0m\n`,
      ),
  }),
});

function render(ev: AgentEvent): void {
  switch (ev.type) {
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
  let history: Message[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const text = (await readPrompt(rl)).trim();
    if (!text || ["q", "exit"].includes(text.toLowerCase())) break;
    history.push({ role: "user", content: text });

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
      const gen = agent.run(history, { signal: ac.signal });
      let r = await gen.next();
      while (!r.done) {
        render(r.value);
        r = await gen.next();
      }
      history = r.value.messages;
    } catch (e) {
      process.stdout.write(
        `\n\x1b[31m[error] ${(e as Error).message}\x1b[0m\n`,
      );
    } finally {
      pendingApproval = null;
      pendingInput = null;
      process.stdin.removeListener("data", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.resume();
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
