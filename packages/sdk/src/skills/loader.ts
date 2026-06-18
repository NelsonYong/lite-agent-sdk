import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface SkillMeta { name?: string; description?: string; tags?: string; [k: string]: string | undefined; }
interface Skill { meta: SkillMeta; body: string; path: string; }

export class SkillLoader {
  readonly skillsDir: string;
  private skills: Record<string, Skill> = {};

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.loadAll();
  }

  private loadAll(): void {
    if (!existsSync(this.skillsDir)) return;
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
    walk(this.skillsDir);
  }

  private parse(text: string): { meta: SkillMeta; body: string } {
    const m = text.match(/^---\n(.*?)\n---\n(.*)/s);
    if (!m) return { meta: {}, body: text };
    const meta: SkillMeta = {};
    for (const line of m[1]!.trim().split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { meta, body: m[2]!.trim() };
  }

  getDescriptions(): string {
    const names = Object.keys(this.skills);
    if (!names.length) return "(no skills available)";
    return names
      .map((n) => {
        const s = this.skills[n]!;
        const tags = s.meta.tags ? ` [${s.meta.tags}]` : "";
        return `  - ${n}: ${s.meta.description ?? "No description"}${tags}`;
      })
      .join("\n");
  }

  getContent(name: string): string {
    const s = this.skills[name];
    if (!s) return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}
