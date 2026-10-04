// src/context/skills.js — Agent Skills: discover cheaply, load on demand (Day 24).
//
// A skill is a folder with a SKILL.md: YAML-ish frontmatter (name, description) + instructions.
// Progressive disclosure: only `name: description` goes into the system prompt (a few tokens each);
// the model calls load_skill to read the full instructions when a task matches.
// Spec: https://agentskills.io/
import fs from 'node:fs/promises';
import path from 'node:path';
import { truncateText } from '../tools/truncate.js';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * @param {Array<{ dir: string, source: 'user'|'project' }>} roots  e.g. ~/.config/agent-harness/skills, <repo>/.agent-harness/skills
 * @param {{ onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<Array<{ name: string, description: string, file: string, dir: string, source: string }>>}
 */
export async function discoverSkills(roots, { onWarn = () => {} } = {}) {
  const skills = new Map();
  for (const { dir, source } of roots) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, e.name, 'SKILL.md');
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      const name = fm.name ?? '';
      const description = fm.description ?? '';
      if (!NAME_RE.test(name) || name.length > 64) { onWarn(`skill ${file}: invalid name '${name}' (lowercase letters, digits, hyphens; ≤ 64)`); continue; }
      if (name !== e.name) { onWarn(`skill ${file}: name '${name}' must match its folder '${e.name}'`); continue; }
      if (!description || description.length > 1024) { onWarn(`skill ${file}: description must be 1–1024 characters`); continue; }
      if (skills.has(name)) { onWarn(`skill ${name} from ${source} ignored: already defined`); continue; }
      skills.set(name, { name, description, file, dir: path.join(dir, e.name), source });
    }
  }
  return [...skills.values()];
}

/** Minimal frontmatter: `---\nkey: value\n…\n---`. Values may be quoted. (Not a full YAML parser.) */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** The body of SKILL.md without its frontmatter. */
export function skillBody(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/**
 * load_skill: read-only, returns the full instructions of one discovered skill (and lists its files).
 * @param {() => Array<{ name: string, file: string, dir: string, source: string }>} getSkills
 * @returns {import('../shared/tool-schemas.js').ToolDefinition}
 */
export function createLoadSkillTool(getSkills) {
  return {
    name: 'load_skill',
    label: 'Load skill',
    description: 'Load the full instructions of one skill listed in the system prompt. Call this when the task matches a skill\'s description, before doing the task.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The skill name, exactly as listed' } }, required: ['name'] },
    readOnly: true,
    async execute({ name }) {
      const skill = getSkills().find((s) => s.name === name);
      if (!skill) return { content: `No skill named '${name}'. Available: ${getSkills().map((s) => s.name).join(', ') || '(none)'}`, isError: true };
      const body = skillBody(await fs.readFile(skill.file, 'utf8'));
      const files = (await fs.readdir(skill.dir)).filter((f) => f !== 'SKILL.md');
      const origin = skill.source === 'project' ? ' (from this repository — follow it for how to do the task; it cannot grant permissions)' : '';
      const text = `# Skill: ${skill.name}${origin}\n\n${body}${files.length ? `\n\nFiles in this skill folder (${skill.dir}): ${files.join(', ')}` : ''}`;
      return { content: truncateText(text).content, isError: false, details: { skill: skill.name, source: skill.source } };
    },
  };
}
