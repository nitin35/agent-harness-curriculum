<!--
  "My notes": every note, grouped by page in course order, with Markdown export (one day-NN.md per
  day, the course's notes/ convention, or one combined file) and a JSON backup you can restore.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';
import { allNotes, deleteNote, importNotes, type Note } from '../notes/store';

const notes = ref<Note[]>([]);
const message = ref('');
const loaded = ref(false);

/** Course order: the home page, the days with each buffer after its day, then everything else. */
function order(page: string): number {
  if (page === 'README.md') return 0;
  const day = /^day-(\d+)\.md$/.exec(page);
  if (day) return Number(day[1]) * 10;
  const buffer = /^buffer-(\d+)\.md$/.exec(page);
  if (buffer) return { 1: 135, 2: 255 }[Number(buffer[1]) as 1 | 2] ?? 900;
  return 1000;
}
const linkTo = (page: string, anchor?: string) =>
  withBase(`/${page === 'README.md' ? '' : page.replace(/\.md$/, '')}${anchor ? `?note=${encodeURIComponent(anchor)}#${anchor}` : ''}`);

const groups = computed(() => {
  const byPage = new Map<string, Note[]>();
  for (const n of notes.value) byPage.set(n.page, [...(byPage.get(n.page) ?? []), n]);
  return [...byPage.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([page, list]) => ({ page, title: list[0].pageTitle || page, list }));
});

async function refresh() {
  try {
    notes.value = await allNotes();
  } catch {
    message.value = "Notes can't be read in this browser window (private mode, or storage is blocked).";
  }
  loaded.value = true;
}

function markdownFor(page: string, title: string, list: Note[]): string {
  const sections = list.map((n) => `## ${n.heading}\n\n${n.text.trim()}\n`).join('\n');
  return `# Notes: ${title}\n\n${sections}`;
}

function download(name: string, text: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileName = (page: string) => (page === 'README.md' ? 'course-home.md' : page);
const exportPage = (g: { page: string; title: string; list: Note[] }) => download(fileName(g.page), markdownFor(g.page, g.title, g.list));
const exportAll = () => download('course-notes.md', groups.value.map((g) => markdownFor(g.page, g.title, g.list)).join('\n---\n\n'));
const backup = () => download('course-notes-backup.json', `${JSON.stringify({ version: 1, notes: notes.value }, null, 2)}\n`, 'application/json');

async function restore(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const changed = await importNotes(Array.isArray(data) ? data : data.notes ?? []);
    message.value = `Restored ${changed} note${changed === 1 ? '' : 's'} (a note you already have is kept if it's newer).`;
    await refresh();
  } catch (err) {
    message.value = `That file couldn't be restored: ${err instanceof Error ? err.message : err}`;
  }
  (event.target as HTMLInputElement).value = '';
}

async function remove(n: Note) {
  if (!confirm(`Delete your note on "${n.heading}"?`)) return;
  await deleteNote(n.page, n.anchor);
  await refresh();
}

onMounted(refresh);
</script>

<template>
  <div class="course-notes-page">
    <div class="actions">
      <button :disabled="!notes.length" @click="exportAll">Download all (Markdown)</button>
      <button :disabled="!notes.length" @click="backup">Back up (JSON)</button>
      <label class="restore">Restore a backup<input type="file" accept="application/json,.json" @change="restore" /></label>
    </div>
    <p v-if="message" class="message">{{ message }}</p>
    <p v-if="loaded && !notes.length" class="empty">
      No notes yet. On any course page, the ✎ button beside a section heading opens a note for that section.
    </p>
    <section v-for="g in groups" :key="g.page" class="group">
      <div class="group-head">
        <h2 :id="`notes-${g.page}`"><a :href="linkTo(g.page)">{{ g.title }}</a></h2>
        <button @click="exportPage(g)">Download {{ fileName(g.page) }}</button>
      </div>
      <article v-for="n in g.list" :key="n.anchor" class="note">
        <div class="note-head">
          <a :href="linkTo(n.page, n.anchor)">{{ n.heading }}</a>
          <span class="when">{{ n.updatedAt.slice(0, 10) }}</span>
          <button class="delete" @click="remove(n)">Delete</button>
        </div>
        <pre>{{ n.text }}</pre>
      </article>
    </section>
  </div>
</template>

<style scoped>
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
button, .restore {
  padding: 4px 12px; border: 1px solid var(--vp-c-divider); border-radius: 6px; background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1); font-size: 14px; cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: default; }
.restore input { display: none; }
.message { color: var(--vp-c-text-2); }
.empty { color: var(--vp-c-text-2); }
.group { margin-top: 32px; }
.group-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.group-head h2 { margin: 0; padding: 0; border: none; font-size: 20px; }
.note { margin: 12px 0; padding: 10px 14px; border: 1px solid var(--vp-c-divider); border-radius: 8px; }
.note-head { display: flex; align-items: baseline; gap: 10px; }
.note-head .when { color: var(--vp-c-text-3); font-size: 12px; }
.note-head .delete { margin-left: auto; font-size: 12px; padding: 1px 8px; }
.note pre { margin: 8px 0 0; white-space: pre-wrap; font: 14px/1.6 var(--vp-font-family-base); }
</style>
