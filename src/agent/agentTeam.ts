import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Model } from "@anthropic-ai/sdk/resources";
import { getClient } from "./client";
import { runBash } from "../tools/bash";
import { writeFile, editFile } from "../tools/file";
import { TASKS } from "../tools/task";

const WORKDIR = process.cwd();
const INBOX_DIR = join(WORKDIR, ".inbox");
const TEAM_DIR = join(WORKDIR, ".team");
const MODEL = (process.env["MODEL_ID"] ?? "claude-sonnet-4-20250514") as Model;

const debug = (...args: unknown[]) =>
  process.stderr.write(`[debug] ${args.join(" ")}\n`);

// --- Constants ---

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const POLL_INTERVAL = 5000;
const IDLE_TIMEOUT = 60000;

// --- Protocol state ---

export const shutdownRequests: Record<string, { target: string; status: string }> = {};
export const planRequests: Record<
  string,
  { from: string; plan: string; status: string }
> = {};

// 处理关闭请求：生成request_id并发送给teammate
export function handleShutdownRequest(teammate: string) {
  const reqId = randomBytes(4).toString("hex");
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  debug(`Shutdown request ${reqId} sent to '${teammate}'`);
  BUS.send(
    "lead",
    teammate,
    "Please shut down gracefully.",
    "shutdown_request",
    { request_id: reqId },
  );
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

// 处理计划审批：批准或拒绝teammate的计划
export function handlePlanReview(requestId: string, approve: boolean, feedback = "") {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}

// --- Types ---

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_submission",
  "plan_approval_response",
] as const);

export const AGENT_TEAM_SCHEMA = [
  {
    name: "spawn_teammate",
    description:
      "Spawn an autonomous teammate. They work independently, auto-claim tasks from the task board, and communicate via inbox.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Unique name for the teammate (e.g. 'alice', 'bob')",
        },
        role: {
          type: "string",
          description:
            "Role description (e.g. 'frontend-dev', 'backend-dev', 'researcher')",
        },
        prompt: {
          type: "string",
          description: "Initial task prompt for the teammate",
        },
      },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List all teammates and their current status.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "broadcast",
    description: "Send a message to all teammates.",
    input_schema: {
      type: "object" as const,
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  {
    name: "shutdown_request",
    description:
      "Request a teammate to shut down gracefully. Returns a request_id for tracking.",
    input_schema: {
      type: "object" as const,
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "shutdown_response",
    description: "Check the status of a shutdown request by request_id.",
    input_schema: {
      type: "object" as const,
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  {
    name: "force_shutdown",
    description:
      "Force a teammate to stop immediately, bypassing the graceful shutdown protocol. Use only after a teammate rejects a shutdown_request.",
    input_schema: {
      type: "object" as const,
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "plan_approval",
    description:
      "Approve or reject a teammate's plan. Provide request_id + approve + optional feedback.",
    input_schema: {
      type: "object" as const,
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
];

type MessageType = typeof VALID_MSG_TYPES extends Set<infer T> ? T : never;

interface BusMessage {
  type: MessageType;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

interface TeamMember {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

type ToolInput = Record<string, string>;

// --- Identity re-injection (survives context compression) ---

function makeIdentityBlock(
  name: string,
  role: string,
  teamName: string,
): Anthropic.MessageParam {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}

// --- MessageBus: JSONL-based inbox system for agent communication ---

class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    mkdirSync(this.dir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType: MessageType = "message",
    extra: Record<string, unknown> = {},
  ): string {
    if (!VALID_MSG_TYPES.has(msgType))
      return `Error: Invalid type '${msgType}'`;
    const msg: BusMessage = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now(),
      ...extra,
    };
    const inboxPath = join(this.dir, `${to}.jsonl`);
    appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    debug(`Message sent: ${sender} -> ${to} [${msgType}]`);
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): BusMessage[] {
    const inboxPath = join(this.dir, `${name}.jsonl`);
    if (!existsSync(inboxPath)) return [];
    const messages = readFileSync(inboxPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BusMessage);
    writeFileSync(inboxPath, "");
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

export const BUS = new MessageBus(INBOX_DIR);

// --- TeammateManager: autonomous agent lifecycle ---

class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private _forceShutdowns = new Set<string>();

  constructor(teamDir: string) {
    this.dir = teamDir;
    mkdirSync(this.dir, { recursive: true });
    this.configPath = join(this.dir, "config.json");
    this.config = this._loadConfig();
  }

  private _loadConfig(): TeamConfig {
    if (existsSync(this.configPath))
      return JSON.parse(readFileSync(this.configPath, "utf8")) as TeamConfig;
    return { team_name: "default", members: [] };
  }

  private _saveConfig(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private _findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  private _setStatus(name: string, status: TeamMember["status"]): void {
    const member = this._findMember(name);
    if (member) {
      member.status = status;
      this._saveConfig();
    }
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this._findMember(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status))
        return `Error: '${name}' is currently ${member.status}`;
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this._saveConfig();
    debug(`Spawned autonomous teammate '${name}' with role '${role}'`);

    this._loop(name, role, prompt).catch((e) => {
      debug(`[${name}] Loop crashed: ${e?.message}`);
      this._setStatus(name, "shutdown");
      BUS.send(name, "lead", `Crashed: ${e?.message}`, "message");
    });
    return `Spawned '${name}' (role: ${role})`;
  }

  // --- Autonomous loop: work → idle → poll → work ---

  private async _loop(
    name: string,
    role: string,
    prompt: string,
  ): Promise<void> {
    const client = getClient();
    const teamName = this.config.team_name;
    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}.
Working directory: ${WORKDIR}

## Your Tools
You have these tools — use them directly, NEVER run tool names as bash commands:
- **bash**: Run shell commands (e.g. bash with command "ls -la")
- **read_file**: Read file contents (path)
- **write_file**: Write content to a file (path, content)
- **edit_file**: Replace text in a file (path, old_text, new_text)
- **send_message**: Send message to lead or another teammate (to, content)
- **read_inbox**: Check your inbox for messages
- **task_list**: List all tasks on the board with status and owner
- **task_update**: Update task status (task_id, status: pending/in_progress/completed)
- **claim_task**: Claim an unowned task from the task board (task_id)
- **idle**: Signal you have no more work — enters idle polling phase
- **plan_approval**: Submit a plan for lead approval (plan)
- **shutdown_response**: Respond to a shutdown request (request_id, approve)

## Workflow
1. First call task_list to see if you have assigned tasks
2. Submit a plan via plan_approval tool, then WAIT for approval before doing major work
3. Execute the plan using bash, read_file, write_file, edit_file
4. When a task is done, call task_update to mark it as completed
5. Check task_list again for more assigned/unclaimed tasks
6. When no more work remains, call idle to enter idle phase (you will auto-claim new tasks)

## MANDATORY PROTOCOLS
1. Before starting any major work, you MUST call the plan_approval tool. NEVER write plans to files or messages — only use the tool. Wait for lead approval.
2. When you receive a shutdown_request, you MUST respond using shutdown_response with the provided request_id.
3. NEVER run tool names as bash commands. "task_list" is NOT a bash command — use the appropriate tool.`;
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    const tools = this._teammateTools();

    // Outer loop: work phase → idle phase → repeat
    while (true) {
      // --- Work phase (max 50 turns) ---
      for (let i = 0; i < 50; i++) {
        // Force shutdown check (highest priority)
        if (this._forceShutdowns.has(name)) {
          this._forceShutdowns.delete(name);
          debug(`[${name}] Force shutdown triggered`);
          this._setStatus(name, "shutdown");
          BUS.send(name, "lead", `'${name}' has been force-shutdown.`, "message");
          return;
        }

        // Read inbox
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            // Direct shutdown for autonomous agents
            this._setStatus(name, "shutdown");
            BUS.send(name, "lead", `'${name}' shut down (graceful request).`, "message");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }

        // API call with retry
        let response: Anthropic.Message | undefined;
        for (let retry = 0; retry <= MAX_RETRIES; retry++) {
          try {
            response = await client.messages.create({
              model: MODEL,
              system: sysPrompt,
              messages,
              tools,
              max_tokens: 8000,
            });
            break;
          } catch (e: any) {
            const status = e?.status ?? e?.error?.status;
            debug(
              `[${name}] API error (attempt ${retry + 1}/${MAX_RETRIES + 1}): ${e.message}`,
            );
            if (status >= 500 && retry < MAX_RETRIES) {
              await new Promise((r) =>
                setTimeout(r, RETRY_DELAY_MS * (retry + 1)),
              );
              continue;
            }
            break;
          }
        }
        if (!response) {
          this._setStatus(name, "shutdown");
          BUS.send(name, "lead", `'${name}' shut down: API call failed after retries.`, "message");
          return;
        }

        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;

        // Execute tools
        const results: Anthropic.ToolResultBlockParam[] = [];
        let idleRequested = false;

        for (const block of response.content) {
          if (block.type === "tool_use") {
            let output: string;
            if (block.name === "idle") {
              idleRequested = true;
              output = "Entering idle phase. Will poll for new tasks.";
            } else {
              output = this._exec(name, block.name, block.input as ToolInput);
            }
            console.log(
              `  [${name}] ${block.name}: ${String(output).slice(0, 120)}`,
            );
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: String(output),
            });
          }
        }
        messages.push({ role: "user", content: results });
        if (idleRequested) break;
      }

      // --- Idle phase: poll inbox + task board ---
      this._setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);

      for (let p = 0; p < polls; p++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));

        // Force shutdown during idle
        if (this._forceShutdowns.has(name)) {
          this._forceShutdowns.delete(name);
          debug(`[${name}] Force shutdown during idle`);
          this._setStatus(name, "shutdown");
          BUS.send(name, "lead", `'${name}' has been force-shutdown (was idle).`, "message");
          return;
        }

        // Check inbox
        const inbox = BUS.readInbox(name);
        if (inbox.length) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              this._setStatus(name, "shutdown");
              BUS.send(name, "lead", `'${name}' shut down (graceful request, was idle).`, "message");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }

        // Scan task board: first check tasks assigned to me, then unclaimed
        const assigned = TASKS.scanAssigned(name);
        const unclaimed = assigned.length ? assigned : TASKS.scanUnclaimed();
        if (unclaimed.length) {
          const task = unclaimed[0];
          if (!task.owner) TASKS.claimTask(task.id, name);
          if (task.status === "pending") TASKS.update(task.id, "in_progress", name);
          const taskPrompt = `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`;
          // Identity re-injection after potential compression
          if (messages.length <= 3) {
            messages.unshift(makeIdentityBlock(name, role, teamName));
            messages.splice(1, 0, {
              role: "assistant",
              content: `I am ${name}. Continuing.`,
            });
          }
          messages.push({ role: "user", content: taskPrompt });
          messages.push({
            role: "assistant",
            content: `Claimed task #${task.id}. Working on it.`,
          });
          resume = true;
          break;
        }
      }

      if (!resume) {
        // Idle timeout — auto shutdown
        debug(`[${name}] Idle timeout, shutting down`);
        this._setStatus(name, "shutdown");
        BUS.send(name, "lead", `'${name}' shut down: idle timeout (${IDLE_TIMEOUT / 1000}s with no new tasks).`, "message");
        return;
      }
      this._setStatus(name, "working");
    }
  }

  private _exec(sender: string, toolName: string, args: ToolInput): string {
    if (toolName === "bash") return runBash(args.command);
    if (toolName === "read_file") {
      try {
        const content = readFileSync(args.path, "utf8");
        return content.slice(0, 50000);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    if (toolName === "write_file") return writeFile(args.path, args.content);
    if (toolName === "edit_file")
      return editFile(args.path, args.old_text, args.new_text);
    if (toolName === "send_message")
      return BUS.send(
        sender,
        args.to,
        args.content,
        args.msg_type as MessageType,
      );
    if (toolName === "read_inbox")
      return JSON.stringify(BUS.readInbox(sender), null, 2);
    if (toolName === "task_list") return TASKS.listAll();
    if (toolName === "task_update")
      return TASKS.update(parseInt(args.task_id), args.status as any, sender);
    if (toolName === "claim_task")
      return TASKS.claimTask(parseInt(args.task_id), sender);
    if (toolName === "shutdown_response") {
      const reqId = args.request_id;
      const approve = args.approve === "true";
      if (shutdownRequests[reqId])
        shutdownRequests[reqId].status = approve ? "approved" : "rejected";
      BUS.send(sender, "lead", args.reason || "", "shutdown_response", {
        request_id: reqId,
        approve,
      });
      return `Shutdown ${approve ? "approved" : "rejected"}`;
    }
    if (toolName === "plan_approval") {
      const planText = args.plan || "";
      const reqId = randomBytes(4).toString("hex");
      planRequests[reqId] = { from: sender, plan: planText, status: "pending" };
      BUS.send(sender, "lead", planText, "plan_submission", {
        request_id: reqId,
        plan: planText,
      });
      return `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
    }
    return `Unknown tool: ${toolName}`;
  }

  private _teammateTools(): Anthropic.Tool[] {
    return [
      {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
          type: "object" as const,
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
          type: "object" as const,
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
      {
        name: "send_message",
        description: "Send message to a teammate.",
        input_schema: {
          type: "object" as const,
          properties: {
            to: { type: "string" },
            content: { type: "string" },
            msg_type: {
              type: "string",
              enum: Array.from(VALID_MSG_TYPES),
            },
          },
          required: ["to", "content"],
        },
      },
      {
        name: "read_inbox",
        description: "Read and drain your inbox.",
        input_schema: { type: "object" as const, properties: {} },
      },
      {
        name: "idle",
        description:
          "Signal that you have no more work. Enters idle polling phase — will auto-claim new tasks.",
        input_schema: { type: "object" as const, properties: {} },
      },
      {
        name: "task_list",
        description:
          "List all tasks on the board with status, owner, and dependencies.",
        input_schema: { type: "object" as const, properties: {} },
      },
      {
        name: "task_update",
        description: "Update a task's status (e.g. mark as completed).",
        input_schema: {
          type: "object" as const,
          properties: {
            task_id: { type: "integer" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["task_id", "status"],
        },
      },
      {
        name: "claim_task",
        description: "Claim an unowned task from the task board by ID.",
        input_schema: {
          type: "object" as const,
          properties: { task_id: { type: "integer" } },
          required: ["task_id"],
        },
      },
      {
        name: "shutdown_response",
        description:
          "Respond to a shutdown request. Approve to shut down, reject to keep working.",
        input_schema: {
          type: "object" as const,
          properties: {
            request_id: { type: "string" },
            approve: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval. Provide plan text.",
        input_schema: {
          type: "object" as const,
          properties: { plan: { type: "string" } },
          required: ["plan"],
        },
      },
    ];
  }

  forceShutdown(name: string): string {
    const member = this._findMember(name);
    if (!member) return `Error: Unknown teammate '${name}'`;
    if (member.status !== "working" && member.status !== "idle")
      return `Error: '${name}' is not active (status: ${member.status})`;
    this._forceShutdowns.add(name);
    debug(`Force shutdown issued for '${name}'`);
    return `Force shutdown issued for '${name}'. Will terminate at next loop iteration.`;
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    const lines = [
      `Team: ${this.config.team_name}`,
      ...this.config.members.map(
        (m) => `  ${m.name} (${m.role}): ${m.status}`,
      ),
    ];
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

export const TEAM = new TeammateManager(TEAM_DIR);
