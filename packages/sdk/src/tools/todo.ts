import { z } from "zod";
import { defineTool } from "@lite-agent/core";
import type { Tool } from "@lite-agent/core";

type TodoStatus = "pending" | "in_progress" | "completed";
interface TodoItem { id: string; text: string; status: TodoStatus; }

const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };

const itemSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
});

class TodoManager {
  private items: TodoItem[] = [];
  update(items: TodoItem[]): string {
    if (items.length > 20) throw new Error("Max 20 todos allowed");
    if (items.filter((t) => t.status === "in_progress").length > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }
    this.items = items;
    return this.render();
  }
  render(): string {
    if (!this.items.length) return "No todos.";
    const lines = this.items.map((t) => `${MARK[t.status]} #${t.id}: ${t.text}`);
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

export function todoTool(): Tool {
  const manager = new TodoManager();
  return defineTool({
    name: "todo",
    description: "Update the task list. Track progress on multi-step tasks.",
    schema: z.object({ items: z.array(itemSchema) }),
    execute: async ({ items }) => manager.update(items),
  });
}
