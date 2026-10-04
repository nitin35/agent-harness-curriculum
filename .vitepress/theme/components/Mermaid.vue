<!--
  A Mermaid diagram, drawn in the browser. Until it's drawn (or with JavaScript off), the reader sees the
  diagram's source, as on any Markdown viewer that doesn't support Mermaid. Redrawn when the theme
  switches between light and dark.
-->
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';

const props = defineProps<{ code: string }>();
const source = decodeURIComponent(props.code);
const svg = ref('');
const failed = ref('');
const { isDark } = useData();
let counter = 0;

async function draw() {
  try {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark.value ? 'dark' : 'default' });
    const id = `mermaid-${Math.random().toString(36).slice(2)}-${counter++}`;
    svg.value = (await mermaid.render(id, source)).svg;
    failed.value = '';
  } catch (err) {
    failed.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(draw);
watch(isDark, draw);
</script>

<template>
  <div class="course-mermaid">
    <div v-if="svg" class="course-mermaid-svg" v-html="svg" />
    <pre v-else class="course-mermaid-source"><code>{{ source }}</code></pre>
    <p v-if="failed" class="course-mermaid-error">The diagram couldn't be drawn: {{ failed }}</p>
  </div>
</template>

<style scoped>
.course-mermaid { margin: 16px 0; overflow-x: auto; }
.course-mermaid-svg :deep(svg) { max-width: 100%; height: auto; }
.course-mermaid-source { font-size: 13px; opacity: 0.7; }
.course-mermaid-error { color: var(--vp-c-danger-1); font-size: 13px; }
</style>
