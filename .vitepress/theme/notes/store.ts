// .vitepress/theme/notes/store.ts — your notes, kept in this browser (IndexedDB), nowhere else.
//
// One note per section: the key is the page and the heading's anchor (its GitHub-style slug), so a
// note survives edits to the course as long as its heading keeps its name. If a heading is renamed or
// removed, the note isn't lost: the page lists it under "Unplaced notes".
import { createStore, entries, get, set, del } from 'idb-keyval';
import { reactive } from 'vue';

export type Note = {
  page: string;        // the page's source file, e.g. 'day-02.md'
  pageTitle: string;   // its H1 when the note was saved
  anchor: string;      // the heading's id, e.g. '3-functions-closures-and-this'
  heading: string;     // the heading's text when the note was saved
  text: string;
  updatedAt: string;   // ISO time
};

const VERSION = 'v1';
const keyOf = (page: string, anchor: string) => `${VERSION}|${page}|${anchor}`;

let store: ReturnType<typeof createStore> | null = null;
function db() {
  // Created on first use, in the browser only (never during the static build).
  store ??= createStore('agent-harness-course', 'notes');
  return store;
}

/** The current page's notes, shared by the editors and the side list. */
export const pageNotes = reactive({
  page: '',
  byAnchor: {} as Record<string, Note>,
  error: '',
});

export async function loadPage(page: string): Promise<void> {
  pageNotes.page = page;
  pageNotes.byAnchor = {};
  try {
    const all = await allNotes();
    if (pageNotes.page !== page) return; // the reader moved on
    pageNotes.byAnchor = Object.fromEntries(all.filter((n) => n.page === page).map((n) => [n.anchor, n]));
    pageNotes.error = '';
  } catch {
    pageNotes.error = "Notes can't be stored in this browser window (private mode, or storage is blocked).";
  }
}

export async function saveNote(note: Omit<Note, 'updatedAt'>): Promise<void> {
  const key = keyOf(note.page, note.anchor);
  if (!note.text.trim()) {
    await del(key, db());
    if (pageNotes.page === note.page) delete pageNotes.byAnchor[note.anchor];
    return;
  }
  const full: Note = { ...note, updatedAt: new Date().toISOString() };
  await set(key, full, db());
  if (pageNotes.page === note.page) pageNotes.byAnchor[note.anchor] = full;
}

export async function deleteNote(page: string, anchor: string): Promise<void> {
  await del(keyOf(page, anchor), db());
  if (pageNotes.page === page) delete pageNotes.byAnchor[anchor];
}

export async function getNote(page: string, anchor: string): Promise<Note | undefined> {
  return get(keyOf(page, anchor), db());
}

export async function allNotes(): Promise<Note[]> {
  const rows = await entries<string, Note>(db());
  return rows.filter(([k]) => String(k).startsWith(`${VERSION}|`)).map(([, v]) => v);
}

/** Merge a JSON backup: for each section, the newer note wins. Returns how many notes changed. */
export async function importNotes(notes: Note[]): Promise<number> {
  let changed = 0;
  for (const n of notes) {
    if (!n || typeof n.page !== 'string' || typeof n.anchor !== 'string' || typeof n.text !== 'string') continue;
    const current = await getNote(n.page, n.anchor);
    if (current && current.updatedAt >= (n.updatedAt ?? '')) continue;
    await set(keyOf(n.page, n.anchor), { ...n, updatedAt: n.updatedAt ?? new Date().toISOString() }, db());
    changed++;
  }
  return changed;
}
