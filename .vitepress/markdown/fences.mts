// .vitepress/markdown/fences.mts — two kinds of code block get a component.
//
//   ```mermaid   → <Mermaid>: the diagram, drawn in the browser (GitHub draws it too).
//   ```js run    → <RunnableCode>: the normal highlighted block, plus Run / Edit / Reset.
//
// GitHub reads only the first word of a fence's info string as its language, so a `js run` block still
// shows as JavaScript there. The marker is the only thing the site needs from the content.
import type MarkdownIt from 'markdown-it';

const encode = (s: string) => encodeURIComponent(s);

export function courseFences(md: MarkdownIt) {
  const original = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const [lang, ...flags] = token.info.trim().split(/\s+/);
    if (lang === 'mermaid') {
      return `<Mermaid code="${encode(token.content)}" />\n`;
    }
    if ((lang === 'js' || lang === 'javascript') && flags.includes('run')) {
      token.info = lang; // highlight it as plain JavaScript
      const highlighted = original(tokens, idx, options, env, self);
      return `<RunnableCode code="${encode(token.content)}">${highlighted}</RunnableCode>\n`;
    }
    return original(tokens, idx, options, env, self);
  };
}
