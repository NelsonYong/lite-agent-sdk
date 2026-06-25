import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import matter from "gray-matter";
import type { AgentDefinition } from "./types";

interface Frontmatter {
  name?: string;
  description?: string;
  tools?: string | string[];
  model?: string;
  [k: string]: unknown;
}

export class AgentLoader {
  readonly dirs: string[];
  private agents: Record<string, AgentDefinition> = {};

  constructor(dirs: string | string[]) {
    this.dirs = Array.isArray(dirs) ? dirs : [dirs];
    this.loadAll();
  }

  private loadAll(): void {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".md")) this.add(p);
      }
    };
    // Walk in order; later dirs overwrite earlier ones on name collision.
    for (const dir of this.dirs) if (existsSync(dir)) walk(dir);
  }

  private add(path: string): void {
    const { data, content } = matter(readFileSync(path, "utf8"));
    const fm = data as Frontmatter;
    const name = fm.name ?? basename(path).replace(/\.md$/, "");
    this.agents[name] = {
      name,
      description: fm.description ?? "No description",
      tools: normalizeTools(fm.tools),
      model: fm.model,
      body: content.trim(),
      path,
    };
  }

  names(): string[] {
    return Object.keys(this.agents);
  }

  list(): AgentDefinition[] {
    return Object.values(this.agents);
  }

  get(name: string): AgentDefinition | null {
    return this.agents[name] ?? null;
  }

  getDescriptions(): string {
    const names = this.names();
    if (!names.length) return "(no subagents available)";
    return names.map((n) => `  - ${n}: ${this.agents[n]!.description}`).join("\n");
  }
}

function normalizeTools(raw: string | string[] | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const cleaned = list.map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}
