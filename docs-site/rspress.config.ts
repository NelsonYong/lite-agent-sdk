import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@rspress/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
  root: "docs",
  base,
  lang: "en",
  title: "Lite Agent",
  description:
    "A pluggable, lightweight agent-core SDK — swappable strategies, onion middleware, typed event stream.",
  icon: "/logo.svg",
  logo: "/logo.svg",
  logoText: "Lite Agent",
  globalStyles: path.join(__dirname, "styles", "index.css"),
  // SSG-MD: emit llms.txt / llms-full.txt and per-page .md files
  // (multilingual sites also get zh/llms.txt).
  llms: true,
  locales: [
    {
      lang: "en",
      label: "English",
      title: "lite-agent",
      description:
        "A pluggable, lightweight agent-core SDK — swappable strategies, onion middleware, typed event stream.",
    },
    {
      lang: "zh",
      label: "简体中文",
      title: "lite-agent",
      description:
        "可插拔、轻量的 Agent 内核 SDK —— 可替换策略、洋葱式中间件、类型化事件流。",
    },
  ],
  themeConfig: {
    darkMode: true,
    footer: {
      // Internal links are raw HTML — prefix them with the deploy base
      // so they don't break under GitHub Pages' /<repo>/ path.
      message:
        '<div class="la-footer-links">' +
        `<a href="${base}sdk/overview">SDK</a>` +
        `<a href="${base}core/overview">Core</a>` +
        `<a href="${base}examples/cli">Examples</a>` +
        '<a href="https://github.com/NelsonYong/lite-agent-sdk">GitHub</a>' +
        '<a href="https://github.com/NelsonYong/lite-agent-sdk/issues">Issues</a>' +
        `<a href="${base}llms.txt">llms.txt</a>` +
        "</div>" +
        '<div class="la-footer-legal">Released under the MIT License · Copyright © 2026 lite-agent contributors</div>',
    },
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/NelsonYong/lite-agent-sdk",
      },
    ],
  },
});
