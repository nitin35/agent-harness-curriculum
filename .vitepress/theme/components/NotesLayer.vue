<!--
  Adds a ✎ button to every section heading (h2, h3) of a course page. It opens a note editor under that
  heading. A heading whose section has a note shows "✎ note". Notes whose heading no longer exists are
  listed at the end of the page, so nothing is lost when the course changes.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { onContentUpdated, useData, withBase } from 'vitepress';
import NotePanel from './NotePanel.vue';
import { deleteNote, loadPage, pageNotes } from '../notes/store';

type Section = { anchor: string; heading: string; slot: HTMLElement; button: HTMLButtonElement };

const { page } = useData();
const sections = ref<Section[]>([]);
const openAnchors = ref<string[]>([]);
const file = computed(() => page.value.filePath); // the source file: README.md, day-02.md, …
const title = computed(() => page.value.title);
const enabled = computed(() => !!file.value && file.value !== 'notes.md' && !page.value.isNotFound);

function headingText(h: HTMLElement): string {
  const copy = h.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.header-anchor, .course-note-btn').forEach((n) => n.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function clear() {
  for (const s of sections.value) { s.button.remove(); s.slot.remove(); }
  // Also anything an earlier, overlapping scan left in the page.
  document.querySelectorAll('.vp-doc .course-note-btn, .vp-doc .course-note-slot').forEach((n) => n.remove());
  sections.value = [];
  openAnchors.value = [];
}

function paint() {
  for (const s of sections.value) {
    const has = !!pageNotes.byAnchor[s.anchor];
    s.button.classList.toggle('has-note', has);
    s.button.textContent = has ? '✎ note' : '✎';
    s.button.title = has ? 'Open your note on this section' : 'Add a note to this section';
  }
}

function toggle(anchor: string) {
  openAnchors.value = openAnchors.value.includes(anchor)
    ? openAnchors.value.filter((a) => a !== anchor)
    : [...openAnchors.value, anchor];
}

// VitePress reports "content updated" more than once per page; only the latest scan may finish.
let generation = 0;

async function scan() {
  const mine = ++generation;
  clear();
  if (!enabled.value) return;
  await loadPage(file.value);
  if (mine !== generation) return;
  clear();
  const doc = document.querySelector('.vp-doc');
  if (!doc) return;
  const found: Section[] = [];
  for (const h of doc.querySelectorAll<HTMLElement>('h2[id], h3[id]')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'course-note-btn';
    button.addEventListener('click', (e) => { e.preventDefault(); toggle(h.id); });
    h.appendChild(button);
    const slot = document.createElement('div');
    slot.className = 'course-note-slot';
    h.after(slot);
    found.push({ anchor: h.id, heading: headingText(h), slot, button });
  }
  sections.value = found;
  paint();
  // Opened from "My notes" or the side list with ?note=<anchor>: open that editor.
  const wanted = new URLSearchParams(location.search).get('note');
  if (wanted && found.some((s) => s.anchor === wanted)) openAnchors.value = [wanted];
}

const unplaced = computed(() => {
  const present = new Set(sections.value.map((s) => s.anchor));
  return Object.values(pageNotes.byAnchor).filter((n) => !present.has(n.anchor));
});

onContentUpdated(scan);
watch(() => pageNotes.byAnchor, paint, { deep: true });
onBeforeUnmount(clear);
</script>

<template>
  <template v-for="s in sections" :key="s.anchor">
    <Teleport v-if="openAnchors.includes(s.anchor)" :to="s.slot">
      <NotePanel :page="file" :page-title="title" :anchor="s.anchor" :heading="s.heading" @close="toggle(s.anchor)" />
    </Teleport>
  </template>
  <div v-if="enabled && pageNotes.error" class="course-notes-error">{{ pageNotes.error }}</div>
  <section v-if="enabled && unplaced.length" class="course-unplaced">
    <h2 class="course-unplaced-title">Unplaced notes</h2>
    <p>These notes belong to sections of this page that have since been renamed or removed. Copy what you need, then delete them.</p>
    <div v-for="n in unplaced" :key="n.anchor" class="course-unplaced-note">
      <div class="head"><strong>{{ n.heading }}</strong> <span class="when">{{ n.updatedAt.slice(0, 10) }}</span></div>
      <pre>{{ n.text }}</pre>
      <button @click="deleteNote(n.page, n.anchor)">Delete</button>
    </div>
    <p><a :href="withBase('/notes')">All your notes</a></p>
  </section>
</template>

<style scoped>
.course-notes-error { margin-top: 24px; font-size: 13px; color: var(--vp-c-warning-1); }
.course-unplaced { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--vp-c-divider); }
.course-unplaced-title { margin: 0 0 8px; font-size: 20px; }
.course-unplaced-note { margin: 12px 0; padding: 10px 12px; border: 1px dashed var(--vp-c-divider); border-radius: 8px; }
.course-unplaced-note pre { white-space: pre-wrap; margin: 6px 0; font-size: 14px; }
.course-unplaced-note .when { color: var(--vp-c-text-3); font-size: 12px; margin-left: 6px; }
.course-unplaced-note button { font-size: 12px; padding: 1px 8px; border: 1px solid var(--vp-c-divider); border-radius: 6px; cursor: pointer; }
</style>
