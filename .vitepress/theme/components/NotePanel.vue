<!--
  The note editor for one section: a Markdown textarea under its heading, saved as you type.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { pageNotes, saveNote } from '../notes/store';

const props = defineProps<{ page: string; pageTitle: string; anchor: string; heading: string }>();
const emit = defineEmits<{ close: [] }>();

const text = ref(pageNotes.byAnchor[props.anchor]?.text ?? '');
const state = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const area = ref<HTMLTextAreaElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

async function save() {
  state.value = 'saving';
  try {
    await saveNote({ page: props.page, pageTitle: props.pageTitle, anchor: props.anchor, heading: props.heading, text: text.value });
    state.value = 'saved';
  } catch {
    state.value = 'error';
  }
}

function grow() {
  const el = area.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, 480)}px`;
}

watch(text, () => {
  grow();
  clearTimeout(timer);
  timer = setTimeout(save, 400);
});

onMounted(() => { grow(); area.value?.focus(); });
onBeforeUnmount(() => { if (timer) { clearTimeout(timer); void save(); } });
</script>

<template>
  <div class="course-note">
    <textarea
      ref="area"
      v-model="text"
      class="course-note-text"
      :aria-label="`Your notes on: ${heading}`"
      placeholder="Your notes on this section (Markdown). Saved in this browser as you type."
      @keydown.esc="emit('close')"
    />
    <div class="course-note-bar">
      <span class="state">
        {{ state === 'saving' ? 'saving…' : state === 'saved' ? (text.trim() ? 'saved' : 'deleted') : state === 'error' ? 'not saved: storage is unavailable' : 'kept in this browser' }}
      </span>
      <button @click="emit('close')">Close</button>
    </div>
  </div>
</template>

<style scoped>
.course-note { margin: 4px 0 16px; border: 1px solid var(--vp-c-brand-soft); border-radius: 8px; background: var(--vp-c-bg-soft); }
.course-note-text {
  display: block; width: 100%; min-height: 72px; padding: 10px 12px; border: none; background: transparent;
  color: var(--vp-c-text-1); font: 14px/1.6 var(--vp-font-family-base); resize: vertical; outline: none;
}
.course-note-bar { display: flex; justify-content: space-between; align-items: center; padding: 4px 10px 6px; font-size: 12px; color: var(--vp-c-text-2); }
.course-note-bar button { padding: 1px 8px; border: 1px solid var(--vp-c-divider); border-radius: 6px; background: var(--vp-c-bg); color: var(--vp-c-text-1); cursor: pointer; }
</style>
