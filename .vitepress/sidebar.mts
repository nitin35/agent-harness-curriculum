// .vitepress/sidebar.mts — the sidebar, generated from the course's own Markdown.
//
// Nothing here lists days or titles. Each day's H1 gives its title, its "**Phase:**" line gives its
// week, and a buffer day's "**When:** after Day N" line places it. Add, rename or reorder a day in the
// Markdown, and the sidebar follows on the next build.
import fs from 'node:fs';
import path from 'node:path';

type Item = { text: string; link: string };
type Group = { text: string; collapsed?: boolean; items: Item[] };

const DAY = /^day-(\d+)\.md$/;
const BUFFER = /^buffer-(\d+)\.md$/;

/** `code` spans become <code>, so titles look the same as in the page. */
function inlineCode(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/`([^`]+)`/g, '<code>$1</code>');
}

function readHead(file: string): { title: string; phase?: string; after?: number } {
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 12);
  const title = (lines.find((l) => l.startsWith('# ')) ?? path.basename(file)).slice(2).trim();
  const phase = lines.find((l) => l.startsWith('**Phase:**'))?.match(/\*\*Phase:\*\*\s*([^·]+)/)?.[1].trim();
  const after = Number(lines.find((l) => l.startsWith('**When:**'))?.match(/after Day (\d+)/)?.[1]) || undefined;
  return { title, phase, after };
}

/** "Day 23 — MCP: Tools from Any Server ⚠ heavier day" → "23 · MCP: Tools from Any Server ⚠" */
function shortTitle(title: string): string {
  return title
    .replace(/^Day (\d+)\s+—\s+/, '$1 · ')
    .replace(/^Buffer Day (\d+)\s+—\s+/, 'Buffer $1 · ')
    .replace(/\s*⚠\s*heavier day\s*$/, ' ⚠');
}

export function buildSidebar(root: string): Group[] {
  const files = fs.readdirSync(root);
  const days = files.filter((f) => DAY.test(f)).sort((a, b) => Number(a.match(DAY)![1]) - Number(b.match(DAY)![1]));
  const buffers = files.filter((f) => BUFFER.test(f)).map((f) => ({ file: f, ...readHead(path.join(root, f)) }));

  const weeks: Group[] = [];
  for (const file of days) {
    const head = readHead(path.join(root, file));
    const week = head.phase ?? 'More';
    let group = weeks.find((g) => g.text === week);
    if (!group) weeks.push((group = { text: week, collapsed: false, items: [] }));
    group.items.push({ text: inlineCode(shortTitle(head.title)), link: `/${file.replace(/\.md$/, '')}` });
    const dayNumber = Number(file.match(DAY)![1]);
    for (const b of buffers.filter((x) => x.after === dayNumber)) {
      group.items.push({ text: inlineCode(shortTitle(b.title)), link: `/${b.file.replace(/\.md$/, '')}` });
    }
  }

  return [
    {
      text: 'Start here',
      items: [
        { text: 'Course home', link: '/' },
        ...(fs.existsSync(path.join(root, 'notes.md')) ? [{ text: 'My notes', link: '/notes' }] : []),
      ],
    },
    ...weeks,
    {
      text: 'Reference',
      items: [
        { text: 'Self-check answers', link: '/self-check-answers' },
        { text: 'Changelog', link: '/CHANGELOG' },
      ],
    },
  ];
}
