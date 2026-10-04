# The HTML edition: how it works and how to update it

The course is the Markdown at the repository root. This folder only presents it as a website (VitePress). Nothing here repeats the course's text, so **updating the course means editing the Markdown**, and the site follows on the next build.

## Everyday changes

| You want to… | Do this |
|---|---|
| Fix or rewrite a day | Edit `day-NN.md`. The sidebar title comes from its `# H1`, its week from its `**Phase:**` line. |
| Add a buffer day | Add `buffer-N.md` with a `**When:** after Day N` line; the sidebar places it after that day. |
| Make a snippet runnable | Change its fence from ```` ```js ```` to ```` ```js run ````. GitHub still shows it as JavaScript. `npm run find:runnable` lists blocks that would run cleanly. |
| Show that a line throws | Put the error in its comment, as the course does: `o.a = 2   // TypeError: …`. `check:runnable` then expects that error. |
| Link to code | Link the path as usual (`solutions/final/`). The site sends folder and file links to GitHub. |

## Local commands

```bash
npm install
npm run docs:dev        # live preview at http://localhost:5173/agent-harness-curriculum/
npm run check:runnable  # every ```js run block must run cleanly (CI runs this too)
npm run docs:build      # the static site in .vitepress/dist; fails on dead links
npm run docs:preview    # serve the build
```

CI (`.github/workflows/site.yml`) runs `check:runnable` and the build on every push, and deploys `main` to GitHub Pages.

## What's where

- `config.mts`: site settings. README.md becomes the home page, anchors use GitHub's slug rules, and code, tests and fixtures are excluded from the pages.
- `sidebar.mts`: builds the sidebar from the pages themselves.
- `markdown/links.mts`: code links → GitHub; `README.md` links → home page.
- `markdown/fences.mts`: ```` ```mermaid ```` → `<Mermaid>`; ```` ```js run ```` → `<RunnableCode>`.
- `theme/runner/`: the snippet runner.
  - `instrument.js` adds REPL-style echoes, and `scripts/runnable.mjs` shares it.
  - `sandbox.js` runs a snippet in an opaque-origin iframe and a worker.
  - `inspect.js` formats values the way Node does.
- `theme/notes/store.ts`: notes in the reader's browser (IndexedDB), keyed by page and heading anchor.
- `theme/components/`: Mermaid, RunnableCode, the notes layer, the page's note list, and the My notes page (`notes.md`).

## Limits worth knowing

- **Runnable snippets get browser JavaScript only.** There is no `fs`, `process` or `Buffer`, and no imports. Node-only examples stay as plain code.
- **Notes stay in one browser.** They don't sync between browsers. "My notes" exports them as Markdown, and the JSON backup moves them to another browser.
- **Renaming a heading changes its anchor.** Notes on it then appear under "Unplaced notes" on that page, until the reader copies or deletes them.
