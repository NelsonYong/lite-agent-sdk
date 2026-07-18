# Skills

一个 skill 就是一个包含 `SKILL.md` 文件的目录——模型按需加载这些指令，而不是让它们在每个 prompt 里白白占用上下文。系统提示中会列出每个 skill 的名称和描述；模型判断某个 skill 相关时，才用 `load_skill` 工具拉取完整正文。你得以用接近零的常驻上下文成本，维护一整个专业指令库。

## 编写 skill

`SKILL.md` 由 YAML frontmatter 加 Markdown 正文组成：

```markdown
---
name: pdf-tools          # optional; defaults to the directory name
description: Extract and merge PDF files  # surfaced in the system prompt
tags: [docs, pdf]        # optional, string or list
---

When the user asks to merge PDFs, run ...
```

把目录放进任一 skill 位置即被自动加载，无需改动代码。

## 加载顺序

同名时后加载的目录覆盖先加载的：

1. 全局：`~/.lite-agent/skills`
2. 项目：`<workdir>/.lite-agent/skills`
3. 配置项 `skillsDir`（如设置）

## 按需注入

运行时系统提示中只出现每个 skill 的名称、描述和标签。模型判断某个 skill 相关时，以其名称调用 `load_skill` 工具，`SKILL.md` 的完整正文随即作为工具结果注入上下文。模型从未触碰的 skill，除了一行列表外不产生任何成本。

## 编程式访问

如需在 `createLiteAgent` 之外使用同一套机制，可直接使用 `SkillLoader` / `loadSkillTool`。

## 另请参阅

- [内置工具](/zh/sdk/tools/builtin-tools)——`load_skill` 工具说明。
- [子代理](/zh/sdk/tools/subagents)——同源的 Markdown 驱动能力（`agents/*.md`）。
- [自定义工具](/zh/sdk/tools/custom-tools)——把可复用行为封装为工具。
- [Agent SDK 概览](/zh/sdk/overview)——skills 在组装好的 agent 中的位置。
