<!--
  Under the page outline: the notes on this page, each linking to its section.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { withBase } from 'vitepress';
import { pageNotes } from '../notes/store';

const notes = computed(() => Object.values(pageNotes.byAnchor).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)));
const firstLine = (t: string) => t.trim().split('\n')[0].slice(0, 80);
</script>

<template>
  <div v-if="notes.length" class="course-page-notes">
    <div class="title">Your notes on this page</div>
    <a v-for="n in notes" :key="n.anchor" :href="`#${n.anchor}`" class="note">
      <span class="heading">{{ n.heading }}</span>
      <span class="line">{{ firstLine(n.text) }}</span>
    </a>
    <a :href="withBase('/notes')" class="all">All your notes →</a>
  </div>
</template>

<style scoped>
.course-page-notes { margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--vp-c-divider); font-size: 13px; }
.title { font-weight: 600; margin-bottom: 6px; }
.note { display: block; padding: 4px 0; color: var(--vp-c-text-2); text-decoration: none; }
.note:hover .heading { color: var(--vp-c-brand-1); }
.heading { display: block; color: var(--vp-c-text-1); font-weight: 500; }
.line { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.all { display: inline-block; margin-top: 6px; color: var(--vp-c-brand-1); }
</style>
