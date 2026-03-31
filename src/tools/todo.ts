type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export interface TodoInput {
  id?: string | number;
  text?: string;
  status?: string;
}

const VALID_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];

const STATUS_MARKER: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};


export const TODO_TOOL_SCHEMA = {
  name: "todo",
  description: "Update task list. Track progress on multi-step tasks.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            // id 是为了区分任务的唯一性
            id: { type: "string" },
            text: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["id", "text", "status"],
        },
      },
    },
    required: ["items"],
  },
}

class TodoManager {
  private items: TodoItem[] = [];

  update(inputs: TodoInput[]): string {
    if (inputs.length > 20) throw new Error("Max 20 todos allowed");

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const text = String(input.text ?? "").trim();
      const status = String(input.status ?? "pending").toLowerCase();
      const id = String(input.id ?? i + 1);

      // 校验参数
      if (!text) throw new Error(`Item ${id}: text required`);
      if (!VALID_STATUSES.includes(status as TodoStatus)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }

      // 一次只能存在一个 in_progress 状态的任务
      if (status === "in_progress") inProgressCount++;
      validated.push({ id, text, status: status as TodoStatus });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "No todos.";

    const lines = this.items.map(
      (item) => `${STATUS_MARKER[item.status]} #${item.id}: ${item.text}`
    );
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);

    const str = lines.join("\n")

    console.log(str);

    return str;
  }
}

export const TODO = new TodoManager();


