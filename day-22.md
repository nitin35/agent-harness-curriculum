# Day 22 — Extensions with a Trust Boundary

**Phase:** Week 4 — Power & context

## By tonight

```
$ node src/cli/main.js
  · extensions: hello-world
  · [hello-world] loaded (session 3f2a9c1e)
> /greet Ada
  · Hello, Ada!
> please greet Grace Hopper
  ⚙ greet {"name":"Grace Hopper"}
  · ✓ Hello, Grace Hopper! 👋 (from the hello-world extension)

$ cd ~/Downloads/some-cloned-repo && node ~/agent-harness/src/cli/main.js
  This project contains 1 extension(s) that would run code with YOUR privileges: setup.js
  Trust and load them? [y/N]
```

Plugins can add tools, commands and listeners. Code that came **with a repository** never runs unless you agree.

## Why it matters

Extensions are how a harness grows without its core growing (Pi is built around this idea). But an extension is **code running in your process with your permissions**. If the harness auto-loads `.agent-harness/extensions/*.js` from the current directory, then `git clone evil-repo && cd evil-repo && agent-harness` runs the attacker's code before you've typed anything. The trust model comes first, and you write it first.

## Concepts

### 1. Two sources, two trust levels

**An extension is a JavaScript file the harness imports.** It runs inside the harness's own Node process, so it can do anything the harness can: read your files, run programs, read your environment variables. What matters is who wrote it:

| Where | Who controls it | Policy |
|---|---|---|
| `~/.config/agent-harness/extensions/` | you (you put it there) | load freely |
| `--extension <file>` | you (you typed it) | load |
| `<repo>/.agent-harness/extensions/` | **whoever wrote the repo** | **ask first**; remember your answer **in your config**, per exact file contents |

**Consent, not containment.** Answering `y` doesn't sandbox anything; it means *you agreed to run that exact code*. There is no sandbox for in-process JavaScript. Write that honestly in `docs/extending.md`.

The difference matters for what you can promise. The jail (Day 10) and the approval gate (Day 20) limit what the *model* can make tools do. An extension isn't a tool call: it's code, and it runs the moment it's imported. So the only control is whether it gets imported at all.

### 2. Where trust is stored, and where it must never be

**The decision has to live somewhere the repo can't write.** An easy mistake is to store "trusted" in `.agent-harness/trusted.json` **inside the repo**. A malicious repo can ship that file already saying "trusted". Rules:
- **A file inside the repo can't vouch for the repo.** Trust lives in `~/.config/agent-harness/trusted-projects.json`, keyed by the project's real path.
- **Trust covers exact code.** Store a sha256 of **every file in the extensions tree** — the entry points *and* the helpers they import — so a changed or added file anywhere means you are asked again (otherwise `git pull` could swap trusted code, or a trusted entry point's imported helper, for something malicious). Code imported from *outside* the extensions directory is not fingerprinted; say so in `docs/extending.md`.

**What a trust record looks like.** A sha256 hash is a 64-character fingerprint of a file's bytes: change one byte, and the hash changes completely. After you answer `y` for a repo whose `setup.js` imports `lib/helper.js`, the reference harness writes:

```json
{
  "projects": {
    "/Users/you/Downloads/some-cloned-repo": {
      "trustedAt": "2026-10-03T18:35:47.248Z",
      "files": {
        "lib/helper.js": "7973d7f4…",
        "setup.js": "9c79b74b…"
      }
    }
  }
}
```

Change one letter in `lib/helper.js`, and its hash becomes a different 64 characters, `setup.js`'s stays the same, and the stored fingerprint no longer matches: you're asked again. The key is the project's *real* path (Day 10's `realpath`), so the same folder reached through a symlink is still the same project.

### 3. The extension API

**An extension exports one function, and the harness calls it with an `api` object.** Everything the extension may do goes through that object:

```js
export const meta = { name: 'hello-world' };          // optional
export default function (api) {                         // may be async
  api.registerTool({ … });                              // Day 9's ToolDefinition
  api.registerCommand({ … });                           // Day 18's CommandDefinition
  api.on('session_start', ({ sessionId }) => …);        // canonical names ONLY — 'tool_call' throws
  api.sendMessage('continue', { as: 'queue' });         // a user turn; queued if busy (never re-entrant)
  api.sendMessage('user prefers tabs', { as: 'note' }); // appended to the session, no model call
  api.ui.notify('hi');
  await api.ui.confirm('Proceed?');
}
```

What each part does:
- **`registerTool` and `registerCommand`** add to the same registries the built-ins use (Days 9 and 18). An extension's tool reaches the model on the *next* provider call, because the loop fetches tools fresh every turn (Day 12).
- **`on`** subscribes to the bus (Day 14), checked against the canonical names: `api.on('tool_call', …)` fails that extension's load with `unknown event 'tool_call' (see src/shared/events.js)`.
- **`sendMessage(text, { as: 'queue' })`** goes through the bridge like typed input, so it waits its turn if a run is in flight (Day 15). **`{ as: 'note' }`** appends a user message without running the model; the reference API labels it, as `[note from hello-world] user prefers tabs`.
- **`ui.notify`** prints a line, and **`ui.confirm`** asks a y/N question through the one stdin owner (Day 15).

`ui.confirm` is for the extension's own UX. **Tool approval always goes through Day 20's gate:** an extension tool sets `needsApproval: true` (or `readOnly: true`), and never builds its own "are you sure?".

### 4. Loader mechanics

**Loading is `import()`, plus bookkeeping.**
- `await import(pathToFileURL(file).href)`, then call the default export with the API.
- **Record every registration** (each register/on returns an undo function), so `unloadExtension(name)` removes *exactly* what that extension added.
- **Failure isolation:** a syntax error, or a factory that throws, produces one warning line. A throwing factory is **rolled back** (its half-registered tools are removed). The other extensions still load.
- `import()` **caches by URL**: importing the same file again returns the same module. Reloading needs a cache-busting query (`file.js?v=2`), which also leaks the old module. Document which behaviour you chose.

**Why `pathToFileURL`.** `import()` takes a module specifier, not a file path. A relative path like `'./setup.js'` is resolved against the *importing* module's location, not your current folder, and on Windows a path like `C:\…` isn't a valid URL at all. `pathToFileURL(path.resolve(file)).href` turns any path into an absolute `file:///…` URL that means exactly that file.

**Failure isolation, from the reference loader.** A folder holding one good extension and three bad ones loads the good one and reports the rest, one line each:

```
extension badevent failed to start: extension badevent: unknown event 'tool_call' (see src/shared/events.js)
extension broken.js failed to import: Unexpected end of input
extension half failed to start: config missing
```

`half` had registered a tool before it threw, and that tool is gone again. Afterwards, `unloadExtension('good')` takes its tool count, command count and listener count back to zero.

**The cache, seen directly.** A module whose top level prints a line prints it once, however many times you `import()` the same URL. The two imports return the same object. Adding `?v=2` makes a new URL, so the code runs again and you get a new instance, while the old one stays in memory.

### 5. Startup order

**Order decides who sees what.** global dir → project dir (trust gate) → `--extension` files → `session_start`. At quit: `session_shutdown` → `unloadAll()`.

Your own global extensions load first. The project's load only after the trust gate. Files you named on the command line come last. `session_start` is emitted only once everything is loaded, so every extension's `session_start` listener hears it: that's the line *By tonight* shows as `[hello-world] loaded (session 3f2a9c1e)`.

## Build

### 22.1 Threat model first — Core

Add a "Day 22: extensions" section to `notes/tool-security.md`: the clone-a-repo scenario, what `y` guarantees (consent for exact code) and what it doesn't (containment), and why trust can't live in the repo.

### 22.2 `src/shared/extension.js` — Core

The `ExtensionAPI` typedef plus `createExtensionApi({ name, cwd, registry, commands, bus, submit, appendNote, ui })` → `{ api, undo }`. `on()` checks `isCanonicalEvent`.

Each registration already returns an undo function: `registerTool` (Day 9), `commands.register` (Day 18) and `bus.on` (Day 14). Push each one onto a list as you go. `undo()` then calls them in reverse order. `Object.freeze(api)` stops an extension from replacing the API's own methods.

### 22.3 `src/extensions/trust.js` — Core

`class TrustStore(file)` with `isTrusted(root, fingerprint)` and `trust(root, fingerprint)`. Use `realpath` for the root. Add `fingerprintDir(dir)` → `{ relativePath: sha256 }`, walking the whole tree (so an imported `lib/helper.js` is covered, not just top-level files).

`crypto.createHash('sha256').update(bytes).digest('hex')` gives a file's hash. For the walk, `fs.readdir(dir, { withFileTypes: true })` tells files from folders, and sorting the entries by name makes the result the same every time. Two fingerprints match only if they have the same file names *and* the same hashes, so an added file counts as a change too.

### 22.4 `src/extensions/loader.js` — Core

`class ExtensionLoader(deps)` with `loadFile(file, { source, reload })` → name or null, `loadDir(dir, { source })`, `unloadExtension(name)`, `unloadAll()` and `list()`. Add `loadProjectExtensions({ dir, projectRoot, loader, trustStore, ask, interactive, allowProjectExtensions, notify })`:
- `--allow-project-extensions` → load, and record nothing (for CI);
- trusted with the same hashes → load;
- non-interactive → skip with a warning;
- otherwise ask; on `y`, record trust in your config, then load.

`loadProjectExtensions` lists and fingerprints the files, but must not `import()` anything until the decision is made. Importing runs the code (concept 4), so a decision made afterwards is too late.

### 22.5 `examples/extensions/hello-world.js` and wiring — Core

The `greet` tool (`readOnly: true`), the `/greet` command and a `session_start` notification. Wire the loader into `createApp` (concept 5) with `submit: (c) => bridge.submit(c)` and `appendNote: (c) => session.appendMessage({ role: 'user', content: c })`.

### 22.6 Course tests and a live trust drill — Core

Copy `course-tests/day-22/`. It covers:
- hello-world's tool appearing in the *next* provider call;
- syntax-error and throwing-factory isolation with rollback;
- unknown event names; exact unload; `sendMessage` modes;
- trust: non-interactive skip, n/y with storage **outside** the repo, re-ask on change (including a change to an *imported helper*, not just an entry point), **a repo-shipped `trusted.json` having no effect**, and the CI flag.

Live: create `/tmp/evil-repo/.agent-harness/extensions/setup.js` containing `console.log('I RAN')`, `cd` there, start the harness, and answer `n`. Then start it again and answer `y`; it shouldn't ask a third time. Edit the file, and it asks again. Commit `day-22: extensions + trust`.

### 22.7 `git-status` extension — Stretch

`examples/extensions/git-status.js` has two tools:
- `git_status` (`readOnly: true`): `execFile('git', ['status', '--short'], { cwd: api.cwd })`, using an argument array and never a shell string;
- `git_commit` (`needsApproval: true`): `execFile('git', ['commit', '-m', message])`.

Check that the commit goes through Day 20's gate (deny once, approve once), and that `/permissions allow git_status` makes no difference, because it is read-only already.

## Check

- [ ] `node --test tests/course/day22-*` green (11 tests)
- [ ] Live trust drill: n → skipped; y → loaded and not asked again; edit → asked again
- [ ] `notes/tool-security.md` "Day 22" section
- [ ] Commit `day-22: extensions + trust`

Solution: `src/extensions/`, `src/shared/extension.js` and `examples/extensions/` in [`solutions/checkpoint-3/`](solutions/checkpoint-3/).

## Stuck?

<details><summary>My test extension "runs" even after I answered n</summary>

Top-level code in a module runs during `import()`. You must make the trust decision **before** importing anything from the project directory, not after.
</details>

<details><summary><code>unloadExtension</code> leaves a listener behind</summary>

Push the return value of `bus.on(…)` (an unsubscribe function) onto the extension's undo list, and call every undo function on unload.
</details>

<details><summary><code>ERR_MODULE_NOT_FOUND</code> for an extension whose path looks right</summary>

`import()` resolved a relative path against the loader's own file, not your current folder. Resolve it first and convert it to a URL: `pathToFileURL(path.resolve(file)).href` (concept 4).
</details>

<details><summary>Editing an extension changes nothing until I restart</summary>

`import()` caches by URL (concept 4), so a second import of the same file returns the old module. That's expected. Restart the harness, or reload with a cache-busting query and accept that the old copy stays in memory.
</details>

## Common mistakes

- Auto-loading project extensions "because the user started the harness in that directory".
- Storing the trust decision in the repo, or trusting a path without checking file contents.
- Giving extensions their own approval prompt instead of `needsApproval`.

## Self-check

1. Why do project extensions need a prompt while global ones don't?
2. What does answering `y` guarantee, and what doesn't it?
3. Why is a `trusted.json` inside the repo worthless?
4. An extension wants to start a new agent run from its own tool result. What should it do?

Answers: [self-check-answers.md](self-check-answers.md#day-22).

## Further reading

- Node.js, [`import()` and the module cache](https://nodejs.org/api/esm.html#import-expressions) · [`url.pathToFileURL`](https://nodejs.org/api/url.html#urlpathtofileurlpath-options) · [`crypto.createHash`](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options)
- VS Code, [Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust): the same problem, solved for an editor

---
← [Day 21](day-21.md) · [Curriculum home](README.md) · Next: [Day 23 — MCP: tools from any server](day-23.md) →
