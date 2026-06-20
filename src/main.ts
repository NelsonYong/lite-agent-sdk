import "dotenv/config";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { anthropic } from "@lite-agent/provider-anthropic";
import { sandboxRuntime } from "@lite-agent/sandbox-anthropic";
import { createLiteAgent, policy } from "@lite-agent/sdk";
import type { AgentEvent, ApprovalHandler, Message } from "@lite-agent/sdk";

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

const agent = createLiteAgent({
  model: anthropic(),
  modelName: process.env["MODEL_ID"],
  workdir,
  skillsDir: join(workdir, "skills"),
  permission: policy({ ask: ["bash", "write_file", "edit_file"] }),
  onApproval,
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
