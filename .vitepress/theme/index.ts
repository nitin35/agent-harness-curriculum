// .vitepress/theme/index.ts — the default VitePress theme, plus the course's components.
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import Mermaid from './components/Mermaid.vue';
import RunnableCode from './components/RunnableCode.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Mermaid', Mermaid);
    app.component('RunnableCode', RunnableCode);
  },
} satisfies Theme;
