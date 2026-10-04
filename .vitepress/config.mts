// .vitepress/config.mts — the HTML edition. The course is the Markdown in this folder; this file only
// says how to present it. Nothing here needs editing when a day changes.
import { defineConfig } from 'vitepress';
import { slug } from 'github-slugger';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSidebar } from './sidebar.mts';
import { codeLinksToGitHub } from './markdown/links.mts';
import { courseFences } from './markdown/fences.mts';

const REPO = 'https://github.com/nitin35/agent-harness-curriculum';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  title: 'Build an Agent Harness',
  description: '30 days, JavaScript, from scratch: a terminal coding agent you build yourself.',
  base: '/agent-harness-curriculum/',
  lang: 'en',
  // An inline icon: no extra file, and no 404 for /favicon.ico.
  head: [['link', { rel: 'icon', href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='85'>⚙</text></svg>" }]],
  lastUpdated: true,
  // Links to http://localhost:11434 point at the reader's own Ollama; every other link must resolve.
  ignoreDeadLinks: 'localhostLinks',

  // The course pages live at the repository root; code, tests and fixtures are not pages.
  srcExclude: ['solutions/**', 'course-tests/**', 'course-assets/**', 'node_modules/**', '.github/**'],
  // README.md is the course home on GitHub, so it is the home page here too.
  rewrites: { 'README.md': 'index.md' },

  markdown: {
    // GitHub's own anchor rules, so links like README.md#environment--course-model work on both.
    anchor: { slugify: (s: string) => slug(s) },
    config(md) {
      codeLinksToGitHub(md, { repo: REPO });
      courseFences(md);
    },
  },

  themeConfig: {
    sidebar: buildSidebar(ROOT),
    outline: { level: [2, 3], label: 'On this page' },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: REPO }],
    editLink: { pattern: `${REPO}/edit/main/:path`, text: 'Edit this page on GitHub' },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: {
      message: 'Text: CC BY 4.0 · Code: MIT',
      copyright: 'The course is the Markdown on GitHub; this site is generated from it.',
    },
  },
});
