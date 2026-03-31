import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface SkillMeta {
  name?: string;
  description?: string;
  tags?: string;
  [key: string]: string | undefined;
}

interface Skill {
  meta: SkillMeta;
  body: string;
  path: string;
}

interface SkillMap {
  [name: string]: Skill;
}

let _instance: SkillLoader | null = null;

export function initSkillLoader(skillsDir: string): SkillLoader {
  _instance = new SkillLoader(skillsDir);
  return _instance;
}

export function getSkillLoader(): SkillLoader {
  if (!_instance) throw new Error("SkillLoader not initialized. Call initSkillLoader first.");
  return _instance;
}

export class SkillLoader {
  skillsDir: string;
  skills: SkillMap;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.skills = {};
    this._loadAll();
  }

  private _loadAll(): void {
    if (!existsSync(this.skillsDir)) return;
    const findSkills = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          findSkills(path);
        } else if (entry.name === "SKILL.md") {
          const text = readFileSync(path, "utf8");
          const { meta, body } = this._parseFrontmatter(text);
          const name = meta.name ?? dirname(path).split("/").pop() ?? path;
          this.skills[name] = { meta, body, path };
        }
      }
    };
    findSkills(this.skillsDir);
  }

  private _parseFrontmatter(text: string): { meta: SkillMeta; body: string } {
    const match = text.match(/^---\n(.*?)\n---\n(.*)/s);
    if (!match) return { meta: {}, body: text };
    const meta: SkillMeta = {};
    for (const line of match[1].trim().split("\n")) {
      if (line.includes(":")) {
        const [key, val] = line.split(":", 2);
        meta[key.trim()] = val.trim();
      }
    }
    return { meta, body: match[2].trim() };
  }

  getDescriptions(): string {
    if (!Object.keys(this.skills).length) return "(no skills available)";
    return Object.entries(this.skills)
      .map(([name, skill]) => {
        const desc = skill.meta.description ?? "No description";
        const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : "";
        return `  - ${name}: ${desc}${tags}`;
      })
      .join("\n");
  }

  getContent(name: string): string {
    const skill = this.skills[name];
    if (!skill)
      return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}
