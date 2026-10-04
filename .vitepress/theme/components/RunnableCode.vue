<!--
  A `js run` block: the normal highlighted code, plus Run, Edit and Reset.
  Run executes the snippet in a sandbox (see ../runner/sandbox.js) and shows what Node's REPL would:
  the value of each line, console output, and errors as `TypeError: …`.
  Edit swaps in a small editor (CodeMirror, loaded on first use). Reset brings back the course's code.
-->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useData } from 'vitepress';

const props = defineProps<{ code: string }>();
const original = decodeURIComponent(props.code).replace(/\n$/, '');
const { isDark } = useData();

type Line = { kind: 'echo' | 'echo-error' | 'log' | 'warn' | 'error'; text: string; line?: number };
const output = ref<Line[]>([]);
const status = ref('');
const running = ref(false);
const editing = ref(false);
const edited = ref(false);
const editorHost = ref<HTMLElement | null>(null);
const view = shallowRef<any>(null);
let themeCompartment: any = null;
let themes: { dark: any; light: any } | null = null;

function currentCode(): string {
  return view.value ? view.value.state.doc.toString() : original;
}

async function run() {
  if (running.value) return;
  running.value = true;
  output.value = [];
  status.value = 'running…';
  const { runSnippet } = await import('../runner/sandbox.js');
  const result = await runSnippet(currentCode(), {
    onEvent(e) {
      if (e.type === 'echo') output.value.push({ kind: 'echo', text: e.text ?? '', line: e.line });
      else if (e.type === 'echo-error') output.value.push({ kind: 'echo-error', text: e.text ?? '', line: e.line });
      else if (e.type === 'log') output.value.push({ kind: e.level === 'warn' ? 'warn' : e.level === 'error' ? 'error' : 'log', text: e.text ?? '' });
      else if (e.type === 'error') output.value.push({ kind: 'error', text: e.text ?? '' });
    },
  });
  status.value = result.status === 'timeout'
    ? 'stopped after 5 s (still running: a loop, or a timer that never ends)'
    : result.status === 'syntax-error' ? 'not run' : `finished in ${result.ms} ms`;
  if (!output.value.length && result.status === 'done') output.value.push({ kind: 'log', text: '(no output)' });
  running.value = false;
}

async function startEditing() {
  editing.value = true;
  await nextTick();
  if (view.value || !editorHost.value) return;
  const [{ EditorView, basicSetup }, { javascript }, { oneDark }, { Compartment, Prec }, { keymap }] = await Promise.all([
    import('codemirror'),
    import('@codemirror/lang-javascript'),
    import('@codemirror/theme-one-dark'),
    import('@codemirror/state'),
    import('@codemirror/view'),
  ]);
  themes = { dark: oneDark, light: [] };
  themeCompartment = new Compartment();
  view.value = new EditorView({
    doc: original,
    parent: editorHost.value,
    extensions: [
      basicSetup,
      javascript(),
      themeCompartment.of(isDark.value ? themes.dark : themes.light),
      // Highest precedence: the default keymap binds Mod-Enter to "insert blank line".
      Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { run(); return true; } }])),
      EditorView.updateListener.of((u) => { if (u.docChanged) edited.value = currentCode() !== original; }),
    ],
  });
  view.value.focus();
}

function reset() {
  if (view.value) view.value.dispatch({ changes: { from: 0, to: view.value.state.doc.length, insert: original } });
  edited.value = false;
  output.value = [];
  status.value = '';
}

watch(isDark, (dark) => {
  if (view.value && themeCompartment && themes) view.value.dispatch({ effects: themeCompartment.reconfigure(dark ? themes.dark : themes.light) });
});
onBeforeUnmount(() => view.value?.destroy());
</script>

<template>
  <div class="course-runnable">
    <div v-show="!editing"><slot /></div>
    <div v-show="editing" ref="editorHost" class="course-runnable-editor" />
    <div class="course-runnable-bar">
      <button class="run" :disabled="running" title="Run (Ctrl/⌘+Enter while editing)" @click="run">▶ Run</button>
      <button v-if="!editing" @click="startEditing">Edit</button>
      <button v-if="editing || edited" :disabled="!edited" @click="reset">Reset</button>
      <span class="status">{{ status }}</span>
    </div>
    <div v-if="output.length" class="course-runnable-output" aria-live="polite">
      <div v-for="(l, i) in output" :key="i" :class="['out', l.kind]">
        <span v-if="l.line" class="ln">line {{ l.line }}</span>
        <span class="arrow" v-if="l.line">{{ l.kind === 'echo' ? '→' : '✗' }}</span>
        <span class="text">{{ l.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.course-runnable { margin: 16px 0; }
.course-runnable :deep(div[class*='language-']) { margin-bottom: 0 !important; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.course-runnable-editor { border: 1px solid var(--vp-c-divider); border-radius: 8px 8px 0 0; overflow: hidden; font-size: 14px; }
.course-runnable-editor :deep(.cm-editor) { max-height: 480px; }
.course-runnable-bar {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  padding: 6px 10px; background: var(--vp-c-bg-soft); border: 1px solid var(--vp-c-divider); border-top: none;
  border-radius: 0 0 8px 8px; font-size: 13px;
}
.course-runnable-bar button {
  padding: 2px 10px; border-radius: 6px; border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg);
  color: var(--vp-c-text-1); font-weight: 500; cursor: pointer;
}
.course-runnable-bar button.run { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.course-runnable-bar button:disabled { opacity: 0.5; cursor: default; }
.course-runnable-bar .status { color: var(--vp-c-text-2); margin-left: auto; }
.course-runnable-output {
  margin-top: 8px; padding: 10px 14px; border-radius: 8px; background: var(--vp-code-block-bg);
  font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-x: auto;
}
.out .ln { color: var(--vp-c-text-3); margin-right: 8px; }
.out .arrow { color: var(--vp-c-text-3); margin-right: 6px; }
.out.echo-error .text, .out.error .text { color: var(--vp-c-danger-1); }
.out.warn .text { color: var(--vp-c-warning-1); }
</style>
