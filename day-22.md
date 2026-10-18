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

There are two startups here. In the first, the harness loads one extension from your own config folder, and that extension says hello when the session starts. It adds a slash command, `/greet`, and a tool, `greet`, which the model calls on its own when you ask it to greet someone. Neither is part of the harness: both came from one small file. The second startup is in a repository you downloaded. It also ships an extension, and this time the harness stops before running a single line of it, names the file, and asks. The default is No.

Plugins can add tools, commands and listeners. Code that came **with a repository** never runs unless you agree.

## Why it matters

Yesterday a second provider slotted in without the loop changing, which proved the seam. Today the harness opens up in a different direction: to code that isn't yours.

Extensions are how a harness grows without its core growing (Pi is built around this idea). But an extension is **code running in your process with your permissions**. Here is how that goes wrong. You clone a repository to look at it, `cd` into it and start the harness, because you want to ask the agent about the code. If the harness auto-loads `.agent-harness/extensions/*.js` from the current directory, then `git clone evil-repo && cd evil-repo && agent-harness` runs the attacker's code before you've typed anything. No approval prompt appears, because no tool was called, and the jail doesn't apply, because nothing went through a tool. The trust model comes first, and you write it first.

## Concepts

### 1. Two sources, two trust levels

An extension is a JavaScript file the harness imports. It runs inside the harness's own Node process, so it can do anything the harness can: read your files, run programs, read your environment variables. What matters is who wrote it:

| Where | Who controls it | Policy |
|---|---|---|
| `~/.config/agent-harness/extensions/` | you (you put it there) | load freely |
| `--extension <file>` | you (you typed it) | load |
| `<repo>/.agent-harness/extensions/` | **whoever wrote the repo** | **ask first**; remember your answer **in your config**, per exact file contents |

**Consent, not containment.** Answering `y` doesn't sandbox anything; it means *you agreed to run that exact code*. There is no sandbox for in-process JavaScript. Write that honestly in `docs/extending.md`.

The difference matters for what you can promise. The jail (Day 10) and the approval gate (Day 20) limit what the *model* can make tools do. An extension isn't a tool call: it's code, and it runs the moment it's imported. So the only control is whether it gets imported at all.

If the answer to "import it?" can be remembered, the memory itself becomes something an attacker would want to forge. So where it's kept matters as much as the question.

### 2. Where trust is stored, and where it must never be

The decision has to live somewhere the repo can't write. An easy mistake is to store "trusted" in `.agent-harness/trusted.json` **inside the repo**. A malicious repo can ship that file already saying "trusted". Rules:
- **A file inside the repo can't vouch for the repo.** Trust lives in `~/.config/agent-harness/trusted-projects.json`, keyed by the project's real path.
- **Trust covers exact code.** Store a sha256 of **every file in the extensions tree**, the entry points *and* the helpers they import, so a changed or added file anywhere means you are asked again. Otherwise `git pull` could swap trusted code, or a trusted entry point's imported helper, for something malicious. Code imported from *outside* the extensions directory is not fingerprinted; say so in `docs/extending.md`.

A sha256 hash is a 64-character fingerprint of a file's bytes: change one byte, and the hash changes completely. Here it is on two lines of a recipe that differ by one character (run this in a file):

```js
import crypto from 'node:crypto';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

sha256('Add 2 eggs and stir.')
// → '0a1c036f1b814450b2aa491c5ed380783e7c93a383e6f1dc4a7c540b889c7c01'
sha256('Add 3 eggs and stir.')
// → 'c910589b041f65d8f87518d8514920302e83770226b79923abc5817a64a925e1'
```

One digit changed, and nothing in the two hashes looks alike. That's what makes a hash useful as a fingerprint: you can't tweak a file a little and keep its hash, so a stored hash that still matches means the file is byte-for-byte the one you approved.

Here is what a trust record looks like. After you answer `y` for a repo whose `setup.js` imports `lib/helper.js`, the reference harness writes:

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

Once an extension is trusted and imported, the next question is what it's allowed to do.

### 3. The extension API

An extension exports one function, and the harness calls it with an `api` object. Everything the extension may do goes through that object:

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

Notice that nothing on the list is new machinery. Each method is a thin door into something you built on an earlier day, which is why an extension's tool gets the same validation, the same approval and the same display as a built-in one.

That's what an extension can do once it runs. How it comes to run is the loader's job.

### 4. Loader mechanics

Loading is `import()`, plus bookkeeping.
- `await import(pathToFileURL(file).href)`, then call the default export with the API.
- **Record every registration** (each register/on returns an undo function), so `unloadExtension(name)` removes *exactly* what that extension added.
- **Failure isolation:** a syntax error, or a factory that throws, produces one warning line. A throwing factory is **rolled back** (its half-registered tools are removed). The other extensions still load.
- `import()` **caches by URL**: importing the same file again returns the same module. Reloading needs a cache-busting query (`file.js?v=2`), which also leaks the old module. Document which behaviour you chose.

`import()` deserves a closer look, because it's where the code actually runs. `import()` is the dynamic form of an `import` statement: you can call it anywhere, with a computed specifier, and it returns a promise. Before that promise fulfils, Node loads the file and runs its top-level code, every statement outside a function, from top to bottom. So an extension doesn't need anyone to call its factory to do damage: anything at its top level has already run by the time `await import(…)` gives you the module. Here is a small module that prints a line at its top level, imported three times (run this in a file):

```js
// greeting.js
console.log('greeting.js: top-level code is running');
export const hello = (name) => `Hello, ${name}!`;
```

```js
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const url = pathToFileURL(path.resolve('greeting.js')).href;
console.log('1. importing');
const first = await import(url);
console.log('2. importing the same URL again');
const second = await import(url);
console.log('3. same module object:', first === second);
const fresh = await import(`${url}?v=2`);
console.log('4. with ?v=2, same object:', first === fresh);
```

```
1. importing
greeting.js: top-level code is running
2. importing the same URL again
3. same module object: true
greeting.js: top-level code is running
4. with ?v=2, same object: false
```

The first import runs the module's code, between lines 1 and 2. The second import of the same URL runs nothing and returns the module object the first one created. A new query string makes a new URL, so the code runs again and you get a second, separate module, while the first stays in memory. That's the cache behaviour the last bullet asks you to choose about.

The file name goes through `pathToFileURL` because `import()` takes a module specifier, not a file path. A relative path like `'./setup.js'` is resolved against the *importing* module's location, not your current folder, and on Windows a path like `C:\…` isn't a valid URL at all. `pathToFileURL(path.resolve(file)).href` turns any path into an absolute `file:///…` URL that means exactly that file.

The factory itself "may be async", and that affects how failures are caught. The loader calls it as `await factory(api)` inside a `try`. Because of the `await`, one `catch` covers both ways a factory can fail: a throw before its first `await`, and a rejection that comes later. This is the other side of Day 14's lesson. The bus didn't await its listeners, so its `try/catch` caught only synchronous throws and it needed a separate rejection handler. The loader does wait, so one `try/catch` is enough. Here it is with a general example, a text editor loading plugins that add menu items:

```js run
const menu = [];                                     // what the plugins have added so far

async function loadPlugin(name, setup) {
  const undo = [];
  const api = {
    addMenuItem(item) {
      menu.push(item);
      undo.push(() => menu.splice(menu.indexOf(item), 1));
    },
  };
  try {
    await setup(api);                                // catches a throw now OR a rejection later
    console.log(`${name}: loaded`);
  } catch (err) {
    for (const fn of undo.reverse()) fn();           // remove what it added before failing
    console.log(`${name}: failed (${err.message}), rolled back`);
  }
}

await loadPlugin('spell-check', (api) => {
  api.addMenuItem('Check spelling');
  throw new Error('dictionary missing');             // fails at once
});
await loadPlugin('cloud-sync', async (api) => {
  api.addMenuItem('Sync now');
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw new Error('server unreachable');             // fails later, after an await
});
await loadPlugin('word-count', (api) => {
  api.addMenuItem('Count words');
});
console.log(`menu: ${menu.join(', ')}`);
// → spell-check: failed (dictionary missing), rolled back
// → cloud-sync: failed (server unreachable), rolled back
// → word-count: loaded
// → menu: Count words
```

Both failing plugins added a menu item before they failed, and both items are gone afterwards, because every addition left an undo function behind. The undo functions run in reverse order, so the last thing added is the first thing removed. The extension loader works exactly this way, with tools, commands and listeners in place of menu items.

Here is failure isolation from the reference loader. A folder holding one good extension and three bad ones loads the good one and reports the rest, one line each:

```
extension badevent failed to start: extension badevent: unknown event 'tool_call' (see src/shared/events.js)
extension broken.js failed to import: Unexpected end of input
extension half failed to start: config missing
```

`half` had registered a tool before it threw, and that tool is gone again. Afterwards, `unloadExtension('good')` takes its tool count, command count and listener count back to zero.

With several sources and a loader for each, the last decision is the order they run in.

### 5. Startup order

Order decides who sees what: global dir → project dir (trust gate) → `--extension` files → `session_start`. At quit: `session_shutdown` → `unloadAll()`.

Your own global extensions load first. The project's load only after the trust gate. Files you named on the command line come last. `session_start` is emitted only once everything is loaded, so every extension's `session_start` listener hears it: that's the line *By tonight* shows as `[hello-world] loaded (session 3f2a9c1e)`.

If `session_start` came earlier, an extension loaded after it would subscribe too late and never hear it, and the strict bus wouldn't complain, because subscribing late is perfectly legal. The order is the only thing that makes the event reach everyone.

## Build

### 22.1 Threat model first — Core

Add a "Day 22: extensions" section to `notes/tool-security.md`: the clone-a-repo scenario, what `y` guarantees (consent for exact code) and what it doesn't (containment), and why trust can't live in the repo.

The threat model comes before any code because it decides the code. Once you've written down that importing is running, "check before you import" stops being a detail and becomes the rule the loader is built around.

### 22.2 `src/shared/extension.js` — Core

The `ExtensionAPI` typedef plus `createExtensionApi({ name, cwd, registry, commands, bus, submit, appendNote, ui })` → `{ api, undo }`. `on()` checks `isCanonicalEvent`.

Each registration already returns an undo function: `registerTool` (Day 9), `commands.register` (Day 18) and `bus.on` (Day 14). Push each one onto a list as you go. `undo()` then calls them in reverse order. `Object.freeze(api)` stops an extension from replacing the API's own methods.

This is the plugin example from concept 4, with the harness's three registries in place of the menu. The work is mostly done already: the earlier days made every registration return its own undo function.

### 22.3 `src/extensions/trust.js` — Core

`class TrustStore(file)` with `isTrusted(root, fingerprint)` and `trust(root, fingerprint)`. Use `realpath` for the root. Add `fingerprintDir(dir)` → `{ relativePath: sha256 }`, walking the whole tree (so an imported `lib/helper.js` is covered, not just top-level files).

`crypto.createHash('sha256').update(bytes).digest('hex')` gives a file's hash. For the walk, `fs.readdir(dir, { withFileTypes: true })` tells files from folders, and sorting the entries by name makes the result the same every time. Two fingerprints match only if they have the same file names *and* the same hashes, so an added file counts as a change too.

The trust store reads and writes a file in your config folder, so it gets the same care as Day 17's sessions: build its path from `globalPaths`, never from a literal `~`.

### 22.4 `src/extensions/loader.js` — Core

`class ExtensionLoader(deps)` with `loadFile(file, { source, reload })` → name or null, `loadDir(dir, { source })`, `unloadExtension(name)`, `unloadAll()` and `list()`. Add `loadProjectExtensions({ dir, projectRoot, loader, trustStore, ask, interactive, allowProjectExtensions, notify })`:
- `--allow-project-extensions` → load, and record nothing (for CI);
- trusted with the same hashes → load;
- non-interactive → skip with a warning;
- otherwise ask; on `y`, record trust in your config, then load.

`loadProjectExtensions` lists and fingerprints the files, but must not `import()` anything until the decision is made. Importing runs the code (concept 4), so a decision made afterwards is too late.

Reading and hashing a file is safe, because it treats the file as bytes. Importing it is what runs it. That's the whole trust boundary, in one ordering rule.

### 22.5 `examples/extensions/hello-world.js` and wiring — Core

The `greet` tool (`readOnly: true`), the `/greet` command and a `session_start` notification. Wire the loader into `createApp` (concept 5) with `submit: (c) => bridge.submit(c)` and `appendNote: (c) => session.appendMessage({ role: 'user', content: c })`.

`submit` goes through the bridge, so an extension's message queues behind a running one exactly as yours does (Day 15). `appendNote` goes straight to the session, which is why a note never starts a model call.

### 22.6 Course tests and a live trust drill — Core

Copy `course-tests/day-22/`. It covers:
- hello-world's tool appearing in the *next* provider call;
- syntax-error and throwing-factory isolation with rollback;
- unknown event names; exact unload; `sendMessage` modes;
- trust: non-interactive skip, n/y with storage **outside** the repo, re-ask on change (including a change to an *imported helper*, not just an entry point), **a repo-shipped `trusted.json` having no effect**, and the CI flag.

Live: create `/tmp/evil-repo/.agent-harness/extensions/setup.js` containing `console.log('I RAN')`, `cd` there, start the harness, and answer `n`. Then start it again and answer `y`; it shouldn't ask a third time. Edit the file, and it asks again. Commit `day-22: extensions + trust`.

`console.log('I RAN')` sits at the file's top level on purpose. It runs on import, with no factory call needed, so if you ever see `I RAN` before the question appears, or at all after answering `n`, your loader imported before it decided.

### 22.7 `git-status` extension — Stretch

`examples/extensions/git-status.js` has two tools:
- `git_status` (`readOnly: true`): `execFile('git', ['status', '--short'], { cwd: api.cwd })`, using an argument array and never a shell string;
- `git_commit` (`needsApproval: true`): `execFile('git', ['commit', '-m', message])`.

Check that the commit goes through Day 20's gate (deny once, approve once), and that `/permissions allow git_status` makes no difference, because it is read-only already.

## Check

The harness can now grow without its core changing. An extension is one file whose factory receives an `api`, and every door in that `api` leads to something you already built: the tool and command registries, the strict bus, the bridge's queue and the single stdin owner. The loader records an undo for every registration, so a failing extension is rolled back and an unloaded one leaves nothing behind. And code that arrived with a repository is fingerprinted, file by file, and never imported until you've said yes to exactly those bytes, with your answer kept in your own config where the repository can't forge it.

Tomorrow, [Day 23](day-23.md) brings in tools from outside the process altogether: MCP servers, which run as separate programs and speak JSON-RPC to your harness.

Before you move on, check:

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

- Auto-loading project extensions "because the user started the harness in that directory". Starting the harness in a folder feels like consent, but it's consent to *look at* the code, not to run it.
- Storing the trust decision in the repo, or trusting a path without checking file contents. Both seem natural, because the decision is about the repo, but each lets the repo answer for itself.
- Giving extensions their own approval prompt instead of `needsApproval`. A custom "are you sure?" looks more careful, but it bypasses the rules, modes and fail-closed defaults of Day 20.

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
