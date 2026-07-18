import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'rspress/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'docs',
  base: process.env.DOCS_BASE ?? '/',
  lang: 'en',
  title: 'lite-agent',
  description:
    'A pluggable, lightweight agent-core SDK — swappable strategies, onion middleware, typed event stream.',
  icon: '/logo.svg',
  logo: '/logo.svg',
  logoText: 'lite-agent',
  globalStyles: path.join(__dirname, 'styles', 'index.css'),
  locales: [
    {
      lang: 'en',
      label: 'English',
      title: 'lite-agent',
      description:
        'A pluggable, lightweight agent-core SDK — swappable strategies, onion middleware, typed event stream.',
    },
    {
      lang: 'zh',
      label: '简体中文',
      title: 'lite-agent',
      description:
        '可插拔、轻量的 Agent 内核 SDK —— 可替换策略、洋葱式中间件、类型化事件流。',
    },
  ],
  themeConfig: {
    darkMode: true,
    footer: {
      message: 'Released under the ISC License.',
    },
    socialLinks: [
      {
        icon: 'github',
        mode: 'link',
        content: 'https://github.com/NelsonYong/lite-agent-sdk',
      },
    ],
    locales: [
      {
        lang: 'en',
        label: 'English',
        outlineTitle: 'On this page',
        lastUpdatedText: 'Last updated',
        nav: [
          {
            text: 'Guide',
            link: '/guide/getting-started',
            activeMatch: '/guide/',
          },
          {
            text: 'Packages',
            link: '/packages/sdk',
            activeMatch: '/packages/',
          },
          {
            text: 'Examples',
            link: '/examples/cli',
            activeMatch: '/examples/',
          },
        ],
      },
      {
        lang: 'zh',
        label: '简体中文',
        outlineTitle: '本页目录',
        lastUpdatedText: '最后更新',
        nav: [
          {
            text: '指南',
            link: '/zh/guide/getting-started',
            activeMatch: '/zh/guide/',
          },
          {
            text: '包',
            link: '/zh/packages/sdk',
            activeMatch: '/zh/packages/',
          },
          {
            text: '示例',
            link: '/zh/examples/cli',
            activeMatch: '/zh/examples/',
          },
        ],
      },
    ],
  },
});
