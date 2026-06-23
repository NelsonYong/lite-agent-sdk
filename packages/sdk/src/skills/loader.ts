import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";

interface SkillMeta { name?: string; description?: string; tags?: string | string[]; [k: string]: unknown; }
interface Skill { meta: SkillMeta; body: string; path: string; }

export class SkillLoader {
  readonly dirs: string[];
  private skills: Record<string, Skill> = {};

  constructor(dirs: string | string[]) {
    this.dirs = Array.isArray(dirs) ? dirs : [dirs];
    this.loadAll();
  }

  private loadAll(): void {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === "SKILL.md") {
          const { meta, body } = this.parse(readFileSync(p, "utf8"));
          const name = meta.name ?? dirname(p).split("/").pop() ?? p;
          this.skills[name] = { meta, body, path: p };
        }
      }
    };
    // Walk in order; later dirs overwrite earlier ones on name collision.
    for (const dir of this.dirs) {
      if (existsSync(dir)) walk(dir);
    }
  }

  private parse(text: string): { meta: SkillMeta; body: string } {
    const { data, content } = matter(text);
    // gray-matter returns data: Record<string, any>; cast is safe for well-formed SKILL.md.
    return { meta: data as SkillMeta, body: content.trim() };
  }

  getDescriptions(): string {
    const names = Object.keys(this.skills);
    if (!names.length) return "(no skills available)";
    return names
      .map((n) => {
        const s = this.skills[n]!;
        const tagList = Array.isArray(s.meta.tags) ? s.meta.tags.join(", ") : s.meta.tags;
        const tags = tagList ? ` [${tagList}]` : "";
        return `  - ${n}: ${s.meta.description ?? "No description"}${tags}`;
      })
      .join("\n");
  }

  names(): string[] {
    return Object.keys(this.skills);
  }

  getContent(name: string): string {
    const s = this.skills[name];
    if (!s) return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}
