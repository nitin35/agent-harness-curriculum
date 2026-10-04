// .vitepress/markdown/links.mts — links to code, not to pages, go to GitHub.
//
// The course links to folders and files such as `solutions/checkpoint-1/` or
// `course-assets/captures/ollama-0.32/`. On GitHub those open the tree; on the site there is no such
// page, so this rewrites them to the repository's tree (folders) or blob (files) URLs. Links to .md pages
// and in-page anchors are left for VitePress, except README.md, which is the site's home page.
import type MarkdownIt from 'markdown-it';
import path from 'node:path';

export function codeLinksToGitHub(md: MarkdownIt, { repo, branch = 'main' }: { repo: string; branch?: string }) {
  md.core.ruler.push('code-links-to-github', (state) => {
    const pageDir = path.posix.dirname((state.env?.relativePath as string | undefined) ?? '');
    const visit = (tokens: any[]) => {
      for (const token of tokens) {
        if (token.children) visit(token.children);
        if (token.type !== 'link_open') continue;
        const href: string | null = token.attrGet('href');
        if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) continue;
        const [target, hash] = href.split('#');
        // README.md is the home page on the site (config rewrites it to index.md): point links there.
        if (path.posix.normalize(path.posix.join(pageDir, target)) === 'README.md') {
          token.attrSet('href', `${path.posix.relative(pageDir, 'index.md') || 'index.md'}${hash ? `#${hash}` : ''}`);
          continue;
        }
        if (target.endsWith('.md') || target === '') continue;
        const resolved = path.posix.normalize(path.posix.join(pageDir, target));
        const kind = target.endsWith('/') ? 'tree' : 'blob';
        token.attrSet('href', `${repo}/${kind}/${branch}/${resolved.replace(/^\.\//, '')}${target.endsWith('/') && !resolved.endsWith('/') ? '/' : ''}`);
      }
    };
    visit(state.tokens);
  });
}
