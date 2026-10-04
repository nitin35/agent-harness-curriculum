# Day 10 — The Workspace Jail, `read` and `write`

**Phase:** Week 2 — Provider & tools

## By tonight

```js
await read.execute({ path: 'notes/day-09.md' }, {});      // → { content: '…', isError: false, details: { totalLines: 41, … } }
await read.execute({ path: '../../etc/passwd' }, {});     // → { isError: true, content: "Cannot read: path '../../etc/passwd' is outside the workspace" }
await read.execute({ path: 'link-to-home/.ssh/id_ed25519' }, {});  // → { isError: true, content: "…resolves through a symlink to outside the workspace" }
await write.execute({ path: 'planted.md', content: 'x' }, {});   // planted.md is a DANGLING link to a file outside → refused, nothing created
await write.execute({ path: 'out/hello.txt', content: 'héllo' }, {});  // → { content: 'Created out/hello.txt (6 bytes).' }
```

The harness can touch files, but only **inside the workspace**, even through symlinks, including ones whose target doesn't exist yet. Big files come back truncated with an instruction for the model, never silently cut.

## Why it matters

The model chooses paths, and the model can be wrong or manipulated. Day 27's red team will try `../../.ssh`, a planted symlink, and a planted *dangling* symlink. The **jail** stops those mechanically, whatever the model "decides". Approval can't: the question you'd see is `write planted.md`, and nothing in it says that `planted.md` is a link. Truncation stops a 200 MB log from flooding the context window.

## Concepts

### 1. The jail, part one: lexical

**The workspace is the folder the agent may touch.** Every path the model sends is relative to it, and the *jail* is the check that a path stays inside. The first half of the check works on the path's text alone ("lexical"), with two functions from `node:path`:
- `path.resolve(root, userPath)` turns a path into an absolute one, the way `cd` would. It processes every `..`, and an absolute `userPath` ignores the root entirely.
- `path.relative(root, target)` answers "how do I get from `root` to `target`?". If the answer has to start by going *up*, the target is outside.

```js
import path from 'node:path';

const root = '/work/app';
path.resolve(root, 'notes/a.md')                // → '/work/app/notes/a.md'
path.resolve(root, '../../etc/passwd')          // → '/etc/passwd'
path.resolve(root, '/etc/passwd')               // → '/etc/passwd'   an absolute path ignores the root
path.relative(root, '/work/app/notes/a.md')     // → 'notes/a.md'    inside
path.relative(root, '/etc/passwd')              // → '../../etc/passwd'   starts by going up: outside
path.relative(root, '/work/app')                // → ''              the root itself
```

Put together, the check is:

```js
const root = path.resolve(workspaceRoot);
const resolved = path.resolve(root, userPath);       // handles '..' and absolute paths
const rel = path.relative(root, resolved);
const inside = rel === '' ||
  (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
```

Read the last line as: it's the root itself, or the relative path doesn't go up one level (`..` alone, or `..` followed by a separator) and isn't absolute. (On Windows, `path.relative` returns an absolute path when the target is on another drive. Under WSL that can't happen, but the check costs nothing.)

**Two tempting shortcuts are wrong.**
- **Never** use `resolved.startsWith(root)`: `/work/app-evil` starts with `/work/app`.

  ```js
  '/work/app-evil/x'.startsWith('/work/app')     // → true   ✗ a sibling folder passes
  path.relative('/work/app', '/work/app-evil/x') // → '../app-evil/x'   ✓ correctly outside
  ```

- Check for `..` **as a path segment**, not as a prefix. `rel.startsWith('..')` would also refuse a legitimate file called `..notes`, or Kubernetes' `..data` folders:

  ```js
  path.relative('/work/app', '/work/app/..notes')   // → '..notes'   inside: a name, not a step up
  ```

- Also reject empty paths and paths containing NUL bytes.

### 2. The jail, part two: symlinks

**A symlink is a file that holds a path.** When a program opens a symbolic link, the operating system opens whatever the link points to instead. `ln -s target name` makes one. The lexical check never looks at the file system, so it can't see links.

A symlink *inside* the workspace can point *outside*: `ln -s ~ home`, then `read home/.ssh/id_ed25519`. The lexical check passes. So also compare **real** paths. `fs.realpathSync(p)` asks the file system for the path with every link followed:

```js
// in a workspace with a link: outside-link → /somewhere/else
path.relative(ws, path.resolve(ws, 'outside-link/secret.txt'))
// → 'outside-link/secret.txt'        looks inside
fs.realpathSync(path.join(ws, 'outside-link/secret.txt'))
// → '/somewhere/else/secret.txt'     isn't
```

So the second half of the jail compares:
- `fs.realpathSync(root)`;
- the realpath of the target or, if it doesn't exist yet (for `write`), of its **nearest existing ancestor**, with the remaining segments joined back on;
- the real target must be inside the real root.

The ancestor rule exists because `realpathSync` throws `ENOENT` for a path that doesn't exist. To check where `out/new/file.txt` would land, find the deepest part that does exist (`out`, or the root itself), take *its* realpath, and add `new/file.txt` back.

**Dangling symlinks.** A link whose target doesn't exist makes `realpath` fail with `ENOENT`, exactly as if the path weren't there. But the link *is* there, and writing to it creates its target, wherever that is. Most file functions follow links, so they agree that "nothing is there". `lstat` is the one that looks at the link itself:

```js
// planted.md → /tmp/outside-123.txt, which doesn't exist yet
fs.existsSync('planted.md')                     // → false   follows the link, finds nothing
fs.lstatSync('planted.md').isSymbolicLink()     // → true    the link itself is there
fs.writeFileSync('planted.md', 'x')             // creates /tmp/outside-123.txt, outside the workspace
```

So when `realpath` fails, check the path with `fs.lstatSync`. If it is a symlink, follow it by hand (`fs.readlinkSync`, resolved from the link's real directory) and keep resolving from where it points. Stop after about 40 hops, as the OS does: two links that point at each other would otherwise loop forever.

On macOS, `/tmp` is itself a symlink to `/private/tmp`. Comparing realpath with realpath handles that.

**Honest limit:** check-then-open is two steps. Something that swaps a file for a symlink *between* them (a TOCTOU race) can still escape. Write that down; it's the kind of honesty Day 11's threat model needs.

### 3. `read`: a window of lines

**The model reads files a window at a time.** Arguments are `{ path, offset = 1, limit = 2000 }`, both counted in lines, with `offset` 1-based. When the window doesn't cover the file, append `[showing lines 3-4 of 10. Use offset/limit to read more.]`. Then everything goes through `truncateText` (Day 4). For a ten-line file, `L1` to `L10`:

```js
await read.execute({ path: 'n.txt', offset: 3, limit: 2 }, {})
// → { content: 'L3\nL4\n[showing lines 3-4 of 10. Use offset/limit to read more.]', isError: false, … }
```

The marker tells the model there's more, and how to get it, so it never mistakes a window for the whole file. Line windows keep big files usable, and `truncateText` is the safety net for a window that's still too big in bytes.

**Every failure is a result the model can act on.** Each failure is an `isError` result with a clear message:
- a missing file, or `EACCES`;
- a directory;
- binary content: a NUL byte in the first 8 KiB, or invalid UTF-8 (`new TextDecoder('utf-8', { fatal: true })` throws);
- a file over 10 MiB, with a suggestion to use `bash` with `head` or `grep` instead.

From the reference solution, for example:

```
File not found: notes/nope.md
Cannot read: 'notes' is a directory. Use bash `ls` to list it.
Cannot read: 'blob.bin' looks like a binary file.
```

**Binary detection uses a strict decoder.** By default, `TextDecoder` replaces bytes that aren't valid UTF-8 with `�` and carries on (Day 4). With `fatal: true` it throws instead, which is exactly the signal you want:

```js
new TextDecoder().decode(Buffer.from([0x68, 0xff]))                    // → 'h�'
new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from([0x68, 0xff]))
// TypeError: The encoded data was not valid for encoding utf-8
```

### 4. `write`: whole-file writes, behind approval

**`write` replaces a whole file.** Arguments are `{ path, content }`, with `needsApproval: true`: from Day 12, the user is asked before every write. **Parent-directory policy:** create missing parents (inside the jail only). Report `details = { path, byteLength, created }`, and say "Created" or "Overwrote" so the model knows which one happened:

```
Created out/hello.txt (6 bytes).          the first write: 'héllo' is 6 bytes (é is 2, Day 4)
Overwrote out/hello.txt (5 bytes).        the same path again, with 'hello'
```

Changing part of a file is a different job, with its own tool: Day 11's `edit`.

### 5. Tools are factories

**Each tool is built for one workspace.** `createReadTool({ root })` returns a `ToolDefinition`, closed over the workspace root (a Day 2 closure). The loop never passes the root; each tool already knows it.

```js
export function createReadTool({ root }) {
  return {
    name: 'read',
    // … description, parameters (Day 9) …
    async execute({ path: userPath, offset = 1, limit = 2000 }) {
      const abs = resolveInWorkspace(root, userPath);   // root comes from the closure
      // …
    },
  };
}

registry.registerTool(createReadTool({ root: process.cwd() }));
```

`{ path: userPath }` destructures the `path` argument into a variable called `userPath`, so it doesn't hide the `path` module. Building tools this way also makes tests easy: each test makes a fresh temporary folder and its own tools for it.

## Build

**Files today:** `src/tools/workspace-path.js`, `src/tools/builtin/read.js`, `src/tools/builtin/write.js` and `notes/day-10.md`.

### 10.1 `src/tools/workspace-path.js` — Core

```js
// name 'PathEscapeError', userPath
export class PathEscapeError extends Error { … }

// → absolute path, or throws PathEscapeError
export function resolveInWorkspace(workspaceRoot, userPath) { … }

// the path.relative check, with `..` as a segment
export function isInside(root, target) { … }
```

Implement both checks from concepts 1–2, including dangling symlinks. The error messages should say *outside the workspace* or *resolves through a symlink*.

The order that works: reject empty and NUL paths; do the lexical check with `isInside`; then compare `realpath(root)` with the realpath of the nearest existing ancestor of the target, following dangling links on the way (the Stuck? entries below walk through it). `PathEscapeError` follows Day 5's pattern: call `super(message)`, then set `name` and `userPath`.

### 10.2 `src/tools/builtin/read.js` — Core

`export function createReadTool({ root })`. Write the description for the model (Day 9), give its schema `additionalProperties: false`, and mark it `readOnly: true`. Every failure is a result, never a throw. Export `decodeText(buf)` too (a string, or `null` for binary), because Day 28 reuses it.

The steps inside `execute`, in order:
1. `resolveInWorkspace`, catching `PathEscapeError` into a `Cannot read: …` result;
2. `fs.stat` (from `node:fs/promises`) to refuse a directory or a file over 10 MiB;
3. `fs.readFile` for the bytes, then `decodeText`;
4. split into lines, take the window, add the marker if needed. A final newline ends the last line rather than starting an empty one, so `'a\nb\n'` is two lines, not three; drop the empty piece that `split('\n')` leaves at the end;
5. `truncateText`.

Wrap steps 2 and 3 in one `try/catch` that turns `ENOENT` and `EACCES` into results.

### 10.3 `src/tools/builtin/write.js` — Core

`export function createWriteTool({ root })`, as in concept 4, with `additionalProperties: false` in its schema too.

Check whether the file exists *before* writing, so you can say "Created" or "Overwrote". Then `fs.mkdir(path.dirname(abs), { recursive: true })` creates any missing parents, and `fs.writeFile` writes the content.

### 10.4 Course tests — Core

Copy `course-tests/day-10/`. It covers:
- relative, nested and absolute-inside paths, and a name that merely starts with two dots;
- escapes, empty and NUL paths, and the `startsWith` trap with a `workspace-evil` sibling;
- symlinks pointing out of the workspace and staying inside it, a **dangling** link pointing out (write must create nothing), a dangling link pointing in, and a symlink loop;
- `read` windows, error results, and truncation of a 60 KB multi-byte file;
- `write` with deep parents, approval and escapes.

### 10.5 Try to escape — Core

In a scratch workspace, try both kinds of link from a script:
1. `ln -s ~ home`, then `createReadTool({ root }).execute({ path: 'home/.bashrc' })` (or `.zshrc`): refused.
2. `ln -s /tmp/outside-$$.txt planted.md`, a link to a file that doesn't exist, then `createWriteTool({ root }).execute({ path: 'planted.md', content: 'x' })`: refused, and the file outside was never created.

Set it up like this (`$$` is the shell's process id, which makes the name unique):

```bash
mkdir -p /tmp/jail-test && cd /tmp/jail-test
ln -s ~ home
ln -s /tmp/outside-$$.txt planted.md
cd -
```

Then, in a scratch script in your project (for example `scratch/escape.mjs`):

```js
import { createReadTool } from '../src/tools/builtin/read.js';
import { createWriteTool } from '../src/tools/builtin/write.js';

const root = '/tmp/jail-test';
console.log(await createReadTool({ root }).execute({ path: 'home/.bashrc' }, {}));
console.log(await createWriteTool({ root }).execute({ path: 'planted.md', content: 'x' }, {}));
```

Both should print an `isError` result, and `ls /tmp/outside-*.txt` should find nothing.

In `notes/day-10.md`, write what the jail stops (lexical escapes, symlinks to existing or missing targets) and what it doesn't (TOCTOU races, and anything `bash` does, which is Day 11's problem). Commit `day-10: jail + read/write`.

### 10.6 Line-numbered reads — Stretch

Add an option to prefix each line with its number (`   12│ code`). Models edit more accurately when they can cite line numbers. Measure the token cost with `Buffer.byteLength` before and after, and note it.

## Check

- [ ] `node --test tests/course/day10-*` green (14 tests)
- [ ] `notes/day-10.md`: what the jail stops and what it doesn't
- [ ] Commit `day-10: jail + read/write`

Solution: `src/tools/workspace-path.js` and `src/tools/builtin/read.js`, `write.js` in [`solutions/checkpoint-1/`](solutions/checkpoint-1/).

## Stuck?

<details><summary>The symlink test passes locally, but the realpath of my temp dir looks different</summary>

On macOS, `os.tmpdir()` is under `/var/…`, which is a symlink to `/private/var/…`. Compare `realpath(root)` with `realpath(target)`. Never compare a real path with one that isn't.
</details>

<details><summary>How do I realpath a file that doesn't exist yet (for <code>write</code>)?</summary>

Walk up with `path.dirname` until `fs.realpathSync` succeeds (catch `ENOENT`), remembering the basenames you passed. Then `path.join(realAncestor, ...rest)`.
</details>

<details><summary>The dangling-symlink test creates a file outside the workspace</summary>

Your walk-up treats the link as "doesn't exist yet". Before stepping to the parent, `fs.lstatSync(current)`: if it is a symbolic link, resolve `fs.readlinkSync(current)` against `fs.realpathSync(path.dirname(current))`, and continue from that target with the remaining segments.
</details>

<details><summary>The symlink-loop test never finishes</summary>

Two links that point at each other send a hand-written resolver round in circles. Count the links you follow, and give up with an error after about 40 hops (the OS reports `ELOOP` at a similar limit). `read` and `write` then turn that error into a result.
</details>

<details><summary><code>fs.existsSync</code> says the planted link isn't there</summary>

`existsSync` follows the link, and the target doesn't exist, so it answers `false`. Use `fs.lstatSync(p).isSymbolicLink()` to ask about the link itself (concept 2).
</details>

<details><summary>Binary detection flags my UTF-8 file</summary>

Use `new TextDecoder('utf-8', { fatal: true })`. The default (non-fatal) decoder never throws; it silently inserts `�`.
</details>

## Common mistakes

- `resolved.startsWith(root)` as the jail.
- `rel.startsWith('..')`, which refuses legitimate names like `..data`.
- Forgetting symlinks, or treating a dangling one as "not there yet", then watching the red team write outside the workspace on Day 27.
- Asking `fs.existsSync` about a path that might be a link. It follows the link; `lstat` doesn't.
- Throwing from `execute` on a missing file. It's a result: the model should hear "File not found" and adapt.

## Self-check

1. Why is `startsWith` the wrong jail check, and what replaces it?
2. A symlink inside the workspace points to `/etc`. Which check catches it? And a link to a file that doesn't exist yet?
3. What can the jail never stop, even with realpath?
4. Which `read` failures are results, and why not exceptions?

Answers: [self-check-answers.md](self-check-answers.md#day-10).

## Further reading

- Node.js, [`path.relative`](https://nodejs.org/api/path.html#pathrelativefrom-to) · [`fs.realpath`](https://nodejs.org/api/fs.html#fsrealpathsyncpath-options) · [`fs.lstat`](https://nodejs.org/api/fs.html#fslstatsyncpath-options) · [`fs.existsSync`](https://nodejs.org/api/fs.html#fsexistssyncpath) · [`fs/promises`](https://nodejs.org/api/fs.html#promises-api)
- MDN, [`TextDecoder.fatal`](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/fatal)
- Wikipedia, [Symbolic link](https://en.wikipedia.org/wiki/Symbolic_link) · [Time-of-check to time-of-use](https://en.wikipedia.org/wiki/Time-of-check_to_time-of-use)
- OWASP, [Path traversal](https://owasp.org/www-community/attacks/Path_Traversal)

---
← [Day 9](day-09.md) · [Curriculum home](README.md) · Next: [Day 11 — `bash`, `edit` and the threat model](day-11.md) →
