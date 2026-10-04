# Day 17 — Sessions on Disk

**Phase:** Week 3 — Interactive harness

## By tonight

```
$ ls ~/.config/agent-harness/sessions/
2026-10-01T14-02-11-512Z_3f2a9c1e.jsonl
$ head -3 ~/.config/agent-harness/sessions/2026-10-01T14-02-11-512Z_3f2a9c1e.jsonl
{"type":"header","version":1,"id":"3f2a9c1e-…","createdAt":"2026-10-01T14:02:11.512Z","cwd":"/Users/you/agent-harness","model":"qwen3.5:4b"}
{"type":"message","message":{"role":"user","content":"How many files are in toy/?"},"id":"a1…","parentId":null,"timestamp":"…"}
{"type":"message","message":{"role":"assistant","content":"","toolCalls":[…]},"id":"b2…","parentId":"a1…","timestamp":"…"}
```

Every run is written to disk when it ends, one line per message, even a run that failed partway. A crash costs you at most the run in flight, never the conversation.

## Why it matters

A harness that forgets everything on Ctrl+C is a toy. Today you build the storage. Tomorrow's commands and Day 19's `/resume` are built on it, and on Day 25 compaction uses its tree structure to shrink long chats without losing anything from the file.

## Concepts

### 1. One append-only JSONL file per session

**A session is one conversation, kept in one file.** JSONL is the same format as Day 4's NDJSON: one complete JSON record per line. "Append-only" means the harness only ever adds lines at the end. It doesn't edit lines that are already there (with two deliberate exceptions, in concept 4). Here are the three choices compared:

| | JSONL (one record per line) | one JSON array | SQLite |
|---|---|---|---|
| Append cost | O(1): one append | O(n): rewrite everything | O(1): a transaction |
| After a crash | at worst, a torn last line | a torn write can lose the file | journal / WAL |
| Inspect it | `cat`, `grep`, `jq -c` | `jq` | needs a client |
| Dependencies | none | none | a native module |
| Queries | scan | scan | indexed |

Sessions are append-heavy, small and greppable, so **JSONL wins**. SQL pays off for query workloads you don't have.

**What "O(n) per message" adds up to.** Say a conversation reaches 200 messages of about 2 KB each. Appending writes each message once: 400 KB in total. Rewriting a JSON array on every message writes 2 KB, then 4 KB, then 6 KB, and so on up to 400 KB: about 40 MB in total, a hundred times more, and growing with the square of the length.

### 2. Header on line 1; the leaf comes from the file itself

**Two kinds of line.** Line 1 is a `SessionHeader`: `{ type: 'header', version: 1, id, createdAt, cwd, model, name? }`. Every other line is an entry: `{ type: 'message', id, parentId, timestamp, message }`. *By tonight* shows one of each.

**Store nothing a crash could leave stale.** The **leaf** (the newest point of the conversation) is **the last entry in the file**, so you never need to store it in the header. A tempting design keeps `leafId` and `updatedAt` in the header, but a crash between "append" and "save the header" leaves them stale. Deriving the leaf from the file can't go stale. "Last modified" comes from the file's `mtime`.

Spelled out, the tempting design has two steps per message:

```
1. append entry e5 to the file                    ✓ done
2. rewrite the header with leafId: 'e5'           ✗ the process dies here
→ the header still says e4, the file ends with e5: which is the conversation?
```

When the leaf is simply "the last entry", there's no second step to miss, so the question can't come up.

### 3. `parentId` makes it a tree

**Each entry points at the entry before it.** Today that's a straight line. On Day 25, compaction re-links the active path through a summary entry, and the old entries stay in the file as an abandoned branch. (Day 6 drew this picture.) Keep this in mind:
- **`getEntries()`** is everything in the file;
- **`getPath()`** walks `parentId` from the leaf back to the root and reverses it. This is what the model sees.

```
file:  a(parent null) · b(parent a) · c(parent b)
getPath(): start at the leaf c → its parent b → its parent a → no parent: stop → reverse → [a, b, c]
```

Today the two lists hold the same entries. They start to differ on Day 25, which is why both exist.

### 4. Crash safety

**Appends survive crashes, mostly.** Appends are one `fs.appendFile` per line. A crash can tear at most the last line, and `readJsonl` **skips a corrupt line with a warning** instead of failing the whole session.

**A torn line has no `\n`.** Reopen that file and append, and the new record is glued onto the torn one, so it is skipped too. Worse, the record after it points at a parent that no longer exists, and `getPath()` stops there: **the model loses everything before the crash**. So `readJsonl` also reports `tornTail` (the file doesn't end in `\n`), and the first append after `open()` writes a `\n` first. `open()` also warns when an entry's parent is missing: a corrupt line in the *middle* cuts the chain, and it shouldn't do that silently.

Here it is with the reference code. A session holds three messages (`one`, `two`, `three`), then a crash leaves half a record at the end. The harness reopens the file and appends `four` and `five`:

```
without the '\n' fix   the path is ['five']
                       warnings: skipped corrupt line 5; an entry's parent is missing
with the '\n' fix      the path is ['one', 'two', 'three', 'four', 'five']
```

`cat -e` (which marks each line end with `$`) shows why the fixed file is fine: the torn fragment sits alone on its line, `{"type":"mess$`, and the new records start on lines of their own.

**Rewrites go to a new file, then replace the old one.** When the header changes, the file is rewritten: write `file.tmp` *next to* the target, then `rename` it over. `rename` is atomic within one filesystem, so readers see the old file or the new one, never half of each. (Without `fsync` a power cut can still lose the latest data, and we accept that.) "Next to" matters: `rename` can't move a file to another filesystem at all (it fails with `EXDEV`), so the temp file must sit in the same folder.

**Write order.** Two `appendFile` calls in flight at once can land in either order, so chain writes through one promise queue:

```js
this.#queue = this.#queue.then(() => appendJsonl(this.path, entry));   // each write waits for the last
```

`#queue` starts as `Promise.resolve()`. Each write is attached to the end of the chain, so it starts only when the previous one has finished, whichever order the callers ran in.

### 5. When to write: after each run

**The session grows between runs, not during them.** The bridge appends a run's messages when the run ends (Day 15's `onRunComplete`), not as each message arrives. `loop.run()` takes the history as a snapshot, and on Day 25 compaction rewrites that history between model calls. If the session also grew during the run, the two would disagree about what the conversation is. The price: `kill -9` in the middle of a run loses that run. Every finished run is safe, and so is every run that failed partway (Day 15 keeps it).

### 6. Where files live, and who can read them

**One folder for everything.** Use `~/.config/agent-harness/` on every OS, computed as `path.join(os.homedir(), '.config', 'agent-harness')` and never written as the literal string `'~/…'`, which `fs` does not expand. An **`AGENT_HARNESS_HOME`** environment variable overrides it, which is how tests stay away from your real files.

`~` is a shell feature. Your shell replaces it with your home folder before a command runs, but Node's `fs` sees the character itself:

```js
fs.readFileSync('~/.config/agent-harness/settings.json')
// Error: ENOENT: no such file or directory, open '~/.config/agent-harness/settings.json'
```

**Session files are private.** Session files hold everything the tools printed: file contents, command output, perhaps a key from `.env`. Make them readable by you only: folders `0o700` (`fs.mkdir(dir, { recursive: true, mode: 0o700 })`) and files `0o600` (`fs.appendFile(file, text, { mode: 0o600 })`). A mode applies when the file is created, so give it on every write that can create one, the atomic rewrite's temp file included.

The modes are octal numbers, one digit each for the owner, the group and everyone else: 6 means read and write, 7 adds "enter" for a folder, and 0 means nothing. `ls -l` shows the same thing as letters:

```
drwx------  …  sessions/
-rw-------  …  sessions/2026-10-03T18-22-32-920Z_3267a159.jsonl
```

## Build

### 17.1 `src/config/paths.js` — Core

`configDir(env = process.env)`, `globalPaths(base)` → `{ base, settings, sessions, logs, extensions, skills, trustedProjects }`, and `projectPaths(cwd)` → `{ base: cwd/.agent-harness, settings, extensions, skills }`.

Every path is `path.join(base, …)`. For example, `globalPaths('/tmp/ah').sessions` is `'/tmp/ah/sessions'` and `.trustedProjects` is `'/tmp/ah/trusted-projects.json'`. `env` is injected (Day 5), so a test can pass `{ AGENT_HARNESS_HOME: '/tmp/ah' }` without touching the real environment.

### 17.2 `src/shared/session.js` and `src/session/jsonl-utils.js` — Core

Typedefs: `SessionHeader`, `MessageEntry`, `CompactionEntry` (used on Day 25), and `SessionEntry`. Then:

```js
// mkdir -p (0o700), JSON + '\n' (0o600)
export async function appendJsonl(filePath, record) { … }
export async function readJsonl(filePath, { onWarn }) { … }          // → { records, skipped, tornTail }
export async function writeJsonlAtomic(filePath, records) { … }      // tmp (0o600) + rename
export async function readFirstLine(filePath) { … }                  // cheap header reads for listings
```

`readJsonl` splits on `'\n'`, skips blank lines, and parses each line in its own `try`, so one bad line costs only itself. `tornTail` is `text.length > 0 && !text.endsWith('\n')`. For `readFirstLine`, open the file with `fs.open` and read only the first few kilobytes, instead of loading a long session just to list it.

### 17.3 `src/session/session-manager.js` — Core

```js
export class SessionManager {
  // nothing written until the first append
  static create({ cwd, model, dir = defaultSessionDir(), name }) { … }
  // header required on line 1; warns about a missing parent
  static async open(filePath, { onWarn }) { … }
  get id() { … }
  async appendMessage(message) { … }
  async appendMessages(messages) { … }
  // assigns id (randomUUID), parentId = current leaf, timestamp; writes the header first if needed
  async appendEntry(partial) { … }
  getEntries() { … }
  getLeafId() { … }
  getPath() { … }
  getMessages() { … }                   // the path as AgentMessage[]
  setModel(model) { … }                 // header change → persisted by save()
  async save() { … }
  async flush() { … }
}
export function defaultSessionDir() { … }
// header-only reads, newest first (by mtime), skip corrupt files;
// with cwd, only sessions started in that folder (Day 19)
export async function listSessions(dir, { onWarn, cwd }) { … }
```

There is no "last session" file. The last session is the newest file, which can't go stale (concept 2's lesson again).

Hints:
- File name: `${createdAt with : and . replaced by -}_${id.slice(0, 8)}.jsonl`, so names sort by time.
- Serialize writes: `#queue = #queue.then(fn)`.
- After `open()`, if `tornTail` was set, the first queued write appends `'\n'` before its record.

Keep the entries twice in memory: an array in file order (for `getEntries`) and a `Map` from id to entry (so `getPath` can look up each parent quickly). `create()` writes nothing, so a harness you start and quit without chatting leaves no empty file behind.

### 17.4 Wire auto-save — Core

In `createApp`, create a session at startup and give the bridge two hooks:
- `getHistory: () => session.getMessages()`;
- `onRunComplete: async ({ newMessages }) => { await session.appendMessages(newMessages); }`. Day 15's bridge already calls it for answered, aborted and partly failed runs.

The model now gets its history **from the session**, which is what makes Day 19's resume real.

Give `createApp` a `home` option (default `configDir()`), and derive every path from `globalPaths(home)`. The course tests pass a temp folder here, so they never touch your real `~/.config/agent-harness`.

### 17.5 Course tests — Core

Copy `course-tests/day-17/`. It covers:
- JSONL round-trip, a torn line, atomic write;
- config paths;
- lazy creation; round-trip with the tool pair; crash without save; **a torn line, then more appends**; a corrupt middle line; `save()` after `setModel`;
- headerless files, `listSessions` order and its `cwd` filter, private file modes.

Then chat in the harness, quit, and `cat` your session file. Commit `day-17: JSONL sessions`.

### 17.6 Crash drill — Stretch

Start a conversation, `kill -9` the harness mid-run, then open the file with `SessionManager.open`. What survived? (Everything up to the last finished run; concept 5 says why.) Then append half a line by hand (`printf '{"type":"mess' >> file`), resume that session, keep chatting, and reopen the file once more. Is the whole conversation still on the path? Time 10,000 `appendMessage` calls and note the result.

## Check

- [ ] `node --test tests/course/day17-*` green (14 tests)
- [ ] A real conversation is on disk under `~/.config/agent-harness/sessions/`
- [ ] `grep -rn "'~/" src` finds nothing
- [ ] Commit `day-17: JSONL sessions`

Solution: `src/config/paths.js`, `src/shared/session.js` and `src/session/` in [`solutions/checkpoint-3/`](solutions/checkpoint-3/) (that snapshot also includes Day 25's additions to `session-manager.js`).

## Stuck?

<details><summary>My entries come back in the wrong order</summary>

Two appends ran concurrently. Chain every write through one promise (`this.#queue = this.#queue.then(() => appendJsonl(…))`).
</details>

<details><summary>After a crash and a resume, the model forgot everything before the crash</summary>

The crash tore the last line, and your first append was glued onto it. Run `cat -e` on the file: the torn line and your record share one line. Keep `tornTail` from `readJsonl`, and write a `'\n'` before the first append after `open()`.
</details>

<details><summary><code>listSessions</code> order flips between runs</summary>

Two files written in the same millisecond have the same `mtime`. Break ties with `createdAt`.
</details>

<details><summary><code>ENOENT: no such file or directory, open '~/…'</code></summary>

A path was written with a literal `~`, which only your shell understands. Build it with `os.homedir()` and `path.join` (concept 6), through `configDir()`.
</details>

<details><summary><code>not a session file (no header on line 1)</code></summary>

The first line written was an entry, not the header. `appendEntry` must write the header first whenever nothing has reached the disk yet (`create()` writes nothing on its own).
</details>

## Common mistakes

- Rewriting the whole file on every message, which makes saving O(n²).
- Treating one corrupt line as fatal and losing a whole session.
- Storing state that a crash can leave stale (a `leafId` in the header, a "last session" pointer).
- Appending after a torn line without a newline: one crash later, the model has amnesia.
- World-readable session files (`0o644`): they hold everything the tools printed.

## Self-check

1. Why JSONL instead of one JSON array or SQLite?
2. A crash tears the last line. What does `readJsonl` do, and what must the next append do?
3. Why are appends and atomic rewrites two different operations?
4. What is the difference between `getEntries()` and `getPath()`, and which one does the model see?

Answers: [self-check-answers.md](self-check-answers.md#day-17).

## Further reading

- [JSON Lines](https://jsonlines.org/) · Node.js, [`fs.appendFile`](https://nodejs.org/api/fs.html#fspromisesappendfilepath-data-options) · [`fs.rename`](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath) · [`fs.mkdir`](https://nodejs.org/api/fs.html#fspromisesmkdirpath-options) (see `mode`)
- Wikipedia, [File-system permissions, numeric notation](https://en.wikipedia.org/wiki/File-system_permissions#Numeric_notation)
- [XDG Base Directory spec](https://specifications.freedesktop.org/basedir-spec/latest/)

---
← [Day 16](day-16.md) · [Curriculum home](README.md) · Next: [Day 18 — Slash commands](day-18.md) →
