// .vitepress/theme/index.ts — the default VitePress theme, plus the course's components.
import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import Mermaid from './components/Mermaid.vue';
import RunnableCode from './components/RunnableCode.vue';
import NotesLayer from './components/NotesLayer.vue';
import PageNotes from './components/PageNotes.vue';
import NotesPage from './components/NotesPage.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'doc-after': () => h(NotesLayer), // ✎ buttons and note editors, inside the page
      'aside-outline-after': () => h(PageNotes), // this page's notes, under the outline
    }),
  enhanceApp({ app }) {
    app.component('Mermaid', Mermaid);
    app.component('RunnableCode', RunnableCode);
    app.component('NotesPage', NotesPage);
  },
} satisfies Theme;
