# Day 26 — The CLI, Secure Settings, Logging and Packaging

**Phase:** Week 5 — Product & proof

## By tonight

```
$ agent-harness -p --no-tools "Say exactly: OK"            # a text-only prompt says so
OK
$ agent-harness -p "Use bash to run: echo hello"            # nobody is there to approve…
  ⚙ bash {"command":"echo hello"}                            (stderr)
  · ✗ Denied bash (needs approval but nobody can answer (non-interactive) — use --auto-approve or an allow rule)
I don't have approval to run the bash command…              (stdout)
warning: 1 tool call was denied (nobody could approve) …    (stderr, exit 4)
$ cd cloned-repo && agent-harness
warning: .agent-harness/settings.json: 'autoApprove' cannot be set by a project file (security) — ignored
$ agent-harness --nope
Unknown option: --nope
Usage: agent-harness [options] [prompt] …                   (exit 2)
```

Your harness is now a real command: layered settings, a log file, readable errors, a scriptable `-p` mode, and an installable package.

## Why it matters

A harness other people can run needs:
- configuration that composes (your defaults, a project's preferences, today's flags);
- logs for when things go wrong;
- errors that say what to do;
- a one-shot mode that scripts and CI can call.

Each of these is also a security surface. A **repository's settings file** is written by whoever wrote the repository, and a naive settings loader lets it switch `autoApprove` on.

## Concepts

### 1. Four layers, last wins, but the project layer is an allow-list

**Settings come in layers, and each layer overrides the one before.** The code has defaults. Your own settings file changes some of them, a project's file changes a few more, and the flags you type change the rest for one run:

```
built-in defaults                               the code
  ← ~/.config/agent-harness/settings.json       YOU
  ← .agent-harness/settings.json                THE REPO
  ← flags                                       YOU, now
```

Here is a real run. Your file says `defaultModel: 'g-model'`, the project's says `'p-model'`, and you type `--model flag-model`. The result is `flag-model`: the last layer wins.

**Who writes each layer is what matters.** Three layers come from you. The project file comes from whoever wrote the repository, and it arrives with every `git clone`. Git itself avoids this problem: a repository's own git settings live in `.git/config`, which a clone never copies. Your `.agent-harness/settings.json` is an ordinary file in the repository, so a stranger's settings land on your disk the moment you clone their code.

**Global (yours): every known key.** Nested objects merge, arrays replace, and an unknown key gives a warning (forward-compatible), never a crash. If your file says `{ compaction: { keepMessages: 9 } }`, then `compaction.keepMessages` becomes 9 and `compaction.enabled` keeps its default, `true`. An array is a value of its own: `permissions: { allow: ['bash(git status)'] }` replaces the default `[]`, and doesn't add to it. A key the loader doesn't know is reported and skipped:

```
unknown setting 'theme' in /home/me/.config/agent-harness/settings.json — ignored
```

**Project (repo-controlled): allow-list only.** A project may:
- **set** harmless preferences (`defaultModel`, `think`, `streaming`, `compaction.enabled`, `compaction.keepMessages`). Choosing the model is still **announced** (`this project selects the model …`), so you know a repo picked it;
- **only tighten**: add to `permissions.deny` (union), choose `permissions.mode: 'read-only'` (and nothing else), shrink `tools.enabled` (intersection), and **lower** `compaction.contextLimit`, `contextWindow` and `maxTurns`. `contextWindow` becomes `num_ctx`, the memory Ollama allocates on *your* machine, and `maxTurns` bounds how long a run goes on: a repo may shrink them, never raise them.

Each allowed key has one rule for how it combines with yours. With your file and a project's file like this:

```js
// yours:     { permissions: { deny: ['bash(rm *)'] }, tools: { enabled: ['read', 'write', 'bash'] },
//              compaction: { contextLimit: 8192 } }
// project:   { permissions: { deny: ['bash(curl*)'], mode: 'read-only' },
//              tools: { enabled: ['read', 'edit'] }, compaction: { contextLimit: 16384 } }
// result:
permissions.deny          // → ['bash(rm *)', 'bash(curl*)']   union: deny rules only add up
permissions.mode          // → 'read-only'                     the one mode a project may pick
tools.enabled             // → ['read']                        intersection: 'edit' can't be added
compaction.contextLimit   // → 8192                            lower: the project's 16384 is ignored
```

**Everything else is ignored with a warning that names the key:** `autoApprove`, `ollamaUrl`, `openai.*`, `provider`, `permissions.allow`, `mcpServers`, `systemPrompt`. An allow-list beats a deny-list because new settings default to *not allowed*. A key added to the harness next month is refused in project files until someone decides it's safe there. With a deny-list, it would be accepted until someone remembers to block it. The warnings look like this (each is one line, wrapped here; the path is the project's real one):

```
…/.agent-harness/settings.json: 'autoApprove' cannot be set by a project file (security) — ignored;
  put it in your global settings if you really want it
…/.agent-harness/settings.json: 'ollamaUrl' cannot be set by a project file (security) — ignored
…/.agent-harness/settings.json: permissions.mode 'yolo' is not stricter than your own setting — ignored
  (a project may only choose 'read-only')
```

Naming each key matters twice. An attack can't hide in silence, and you learn which legitimate preference to move into your own file.

**Flags:** `--model`, `--provider`, `--system-prompt`, `--tools a,b`, `--no-tools`, `--permission-mode`, and `--auto-approve` (= `yolo`; deny rules still apply). `--tools read,bash` becomes `['read', 'bash']`, and `--no-tools` becomes `[]`.

**Skip three dangerous keys.** Also skip `__proto__`, `constructor` and `prototype` keys while merging. Repo JSON must not pollute your objects. `JSON.parse` turns `"__proto__"` into an ordinary key, and a naive merge then writes through it into `Object.prototype`, which every object in the process inherits from. *Run this in a file*, in a process of its own:

```js run
const repo = JSON.parse('{"__proto__": {"polluted": true}}');
Object.keys(repo)                  // → ['__proto__']: an ordinary key after JSON.parse

function naiveMerge(target, src) {
  for (const k of Object.keys(src)) {
    if (typeof src[k] === 'object') naiveMerge(target[k] ??= {}, src[k]);
    else target[k] = src[k];
  }
}
naiveMerge({}, repo);              // target['__proto__'] is Object.prototype itself
({}).polluted                      // → true: every object now has it
```

### 2. The settings shape

**Every key has a default, and the defaults are frozen.** These are the reference's `DEFAULT_SETTINGS`:

```js
{
  provider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  openai: {
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: 'OPENAI_API_KEY',                  // the key lives in that env var
  },
  defaultModel: 'qwen3.5:4b',
  contextWindow: 8192,
  think: true,
  maxTurns: 20,
  streaming: true,
  autoApprove: false,
  tools: { enabled: null },                       // null = every tool; a list = only these
  permissions: { mode: 'default', allow: [], deny: [] },
  compaction: { enabled: true, contextLimit: null, keepMessages: 6 },
  mcpServers: {},                                  // global file only
  systemPrompt: '',
}
```

Some keys need a second look:
- **`openai.apiKeyEnv`** holds the *name* of an environment variable, never the key itself (Day 21). Settings files get copied, shared and committed; an environment variable stays on the machine. A value that doesn't look like a variable name is refused, and the error doesn't repeat it: a value in that place is often the key itself, and stderr can end up in a CI log.
- **`tools.enabled: null`** means every registered tool. `[]` means none, which is what `--no-tools` sets.
- **`compaction.contextLimit: null`** means no cap: the window is what the provider gives (Day 24).

`DEFAULT_SETTINGS` is deep-frozen, and `loadSettings` starts each time from a `structuredClone` of it. Code that tries to change the defaults fails loudly instead of changing them for every later load:

```js
DEFAULT_SETTINGS.maxTurns = 99;
// TypeError: Cannot assign to read only property 'maxTurns' of object '#<Object>'
DEFAULT_SETTINGS.permissions.allow.push('bash(*)');
// TypeError: Cannot add property 0, object is not extensible
```

**Validate types on load.** A bad value is a **user** error naming the key and the file, and exits 2:

```
/home/me/.config/agent-harness/settings.json: 'contextWindow' must be an integer ≥ 1024 (got 10)
/home/me/.config/agent-harness/settings.json: 'maxTurns' must be a positive integer (got "lots")
```

A setting that's wrong in a file is wrong on every launch, so the harness refuses to start rather than guess. The message says which file to open and which key to fix.

### 3. Logs go to a file, never to stdout

**Logs are for later.** When something went wrong an hour ago, the log is the only record of what the harness did. The reference writes `~/.config/agent-harness/logs/harness.log`, one line per event: `[2026-10-01T09:12:44.123Z] [info] [agent-loop] turn 2 finished`. The parts are the time, the level, and the module that wrote the line. Each module gets its own tagged logger from `logger.child('agent-loop')`, so `grep '\[cli\]'` finds one module's lines.

Levels filter what gets written: `debug` < `info` < `warn` < `error`. The default is `info`, and `--verbose` (`-V`) turns on `debug`.

**Four rules make the file useful:**
- **Flatten newlines** inside messages, or one log entry becomes several lines. The reference turns each newline into ` ⏎ `, so `'turn 2\nfinished'` is logged as `turn 2 ⏎ finished`, and a stack trace stays on one line.
- **Rotate** at 1 MiB (rename to `.1` and keep one generation). Before each write, a file over the limit is renamed to `harness.log.1`, replacing the old one, and a new file starts.
- **Writes are synchronous,** because the error handler logs right before the process ends and an async write scheduled there never happens. `fs.appendFile` only *schedules* the write for a later turn of the event loop, and a process that's exiting has no later turn. `fs.appendFileSync` finishes before it returns. (Day 11's exit hook had the same rule.)
- **Never write to stdout:** in `-p` mode, stdout is the *answer* a script is parsing. In `agent-harness -p "…" > answer.txt`, a log line on stdout would end up in `answer.txt`.

Logging must also never crash the harness: the reference wraps each write in `try`, and a full disk costs you log lines, not the run.

### 4. Errors in three voices

**Who has to act decides how an error is shown.** A bad flag is yours to fix, a stopped server is yours to start, and a bug is the harness's own. Each gets a different message:

| Category | Example | What the user sees |
|---|---|---|
| `user` | bad flag, bad setting | the problem + usage hint; exit 2 |
| `provider` | Ollama down, model missing | the fix: *"is Ollama running? (`ollama serve`)"*, *"`ollama pull …`"*; exit 1 |
| `internal` | a bug | `internal error: … (details in ~/.config/agent-harness/logs/harness.log)`; the stack goes to the log; exit 1 |

`categorizeError` reads the `category` that Day 5's error classes carry. A plain error from `fetch` has none, so it also checks the cause: Node reports a refused connection as `TypeError: fetch failed` with `cause.code === 'ECONNREFUSED'`. Everything else is `internal`. The real messages:

```
fetch failed — is Ollama running? (`ollama serve`)
Cannot reach Ollama at http://127.0.0.1:59999 — is Ollama running? (`ollama serve`)
internal error: oops (details in /home/me/.config/agent-harness/logs/harness.log)
```

The middle line is the provider's own `ProviderError` (Day 8), which already names the URL.

**One path for fatal errors.** `uncaughtException` and `unhandledRejection` route through the same handler, which logs, prints one line, and **restores the terminal** via one `shutdown()` path. Set `process.exitCode` instead of calling `process.exit()`, which can truncate stdout that's still buffered in a pipe.

You can watch the truncation happen. On Linux and macOS, writes to a pipe are asynchronous, and `process.exit()` doesn't wait for them:

```bash
node -e "process.stdout.write('x'.repeat(1e6)); process.exit(0)" | wc -c     # → 65536 (on macOS)
node -e "process.stdout.write('x'.repeat(1e6)); process.exitCode = 0" | wc -c # → 1000000
```

With `exitCode`, Node exits by itself once nothing is left to do, and pending writes are part of "something to do".

**Signals.** SIGTERM (`kill`, a process supervisor) and SIGHUP (a closed terminal) end Node *without* an `'exit'` event unless someone handles them, so the `bash` tool's exit hook (Day 11) never runs, and a running command outlives the harness. When `main.js` runs as the program, handle both: call `killAllCommands()`, then exit with 143 or 129.

Those numbers follow the shell's convention: a process ended by signal N reports 128 + N. SIGHUP is 1, SIGINT (Ctrl+C) is 2 and SIGTERM is 15, so they give 129, 130 and 143. A Node process with an `'exit'` hook, killed with `kill -TERM`, reports 143 and never runs the hook. With a SIGTERM handler that calls `process.exit(143)`, the hook runs. Here `process.exit()` is right: the process has been told to stop, and the handler's job is to clean up on the way out.

### 5. Modes

**One command, five ways to start it:**

| Invocation | Mode |
|---|---|
| `agent-harness` | interactive; offers to resume this folder's last session |
| `agent-harness -c` | continue this folder's last session |
| `agent-harness --resume` | pick one of this folder's sessions |
| `agent-harness --new` | fresh, no question |
| `agent-harness -p "…"` (or `echo "…" \| agent-harness -p`) | one answer on stdout. **Approval-needing tools are denied unless you opt in** (Day 20) |

The first four map onto Day 19's `start({ resume })`: `'ask'`, `'last'`, `'pick'` and `'new'`. `'pick'` is new today: it shows Day 19's `/resume` picker at startup. `-p` is the one for scripts. It reads the prompt from its arguments, or from stdin when stdin isn't a terminal, and writes only the answer to stdout. Tool lines and warnings go to stderr, so `agent-harness -p "…" > answer.txt` captures exactly the answer.

**Exit codes:** 0 ok · 1 runtime error · 2 usage or settings error · 3 no final answer (`maxTurns` ran out) · 4 answered, but tool calls were denied · 130 interrupted. Codes 3 and 4 matter for `-p`, where a script or CI job reads the result:
- **3:** the run stopped at `maxTurns`, so stdout holds no answer.
- **4:** tool calls were refused: nobody could approve them, or one of your rules or your permission mode said no. The answer can't reflect what they would have done, and models *sometimes answer as if a denied command ran*: in 7 live runs of `-p "Use bash to run: echo hello"`, all denied, one printed `hello`. So `-p` says how many calls were denied on stderr and exits 4. To count them without parsing text, the loop marks a denied call in its tool log (`denied: true`, from the denial's `details`, which never reach the model). A refusal because nobody could answer also carries `unanswered: true`, so the warning can say which it was: `(nobody could approve)` or `(refused by your rules or mode)`.
- **A prompt that needs no tools should say so with `--no-tools`.** Small models reach for a tool even when they don't need one: live, `-p "Say exactly: OK"` called `bash echo "OK"` in 2 of 3 runs, was denied, answered `OK`, and exited 4. With `--no-tools` it exited 0 every time. Exit 4 means *the model wanted a tool you didn't allow*: allow it, or rule tools out.

A script reads the code from `$?`:

```bash
agent-harness -p "Summarise CHANGES.md" > summary.txt
case $? in
  0) echo "ok" ;;
  3) echo "no final answer" ;;
  4) echo "a tool call was denied: the summary may be wrong" ;;
  *) echo "failed" ;;
esac
```

Python contrast: `subprocess.run([...]).returncode` gives the same number.

### 6. Packaging

**`package.json` turns the folder into a command and a library.** `package.json` gets:
- `"bin": { "agent-harness": "./src/cli/main.js" }` (the file starts with `#!/usr/bin/env node`);
- `"exports": { ".": "./src/index.js" }`, `"files"` and `"engines": { "node": ">=22" }`.

Each field has one job:
- **`bin`** names a command and the file it runs. The shebang (Day 15) tells the operating system to run that file with `node`.
- **`exports`** is the library's front door. `import { createApp } from 'agent-harness'` loads `src/index.js`, and a deep import such as `agent-harness/src/app.js` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Your internal file layout can then change without breaking anyone's code.
- **`files`** lists what gets published (`src` and `README.md`), so your notes and tests stay out of the package. `npm pack --dry-run` shows the list.
- **`engines`** says which Node versions the package supports, and npm warns when someone installs it on an older one.

`src/index.js` re-exports a curated library API, and importing it must start nothing. A program that imports `createApp` to embed your harness expects no settings to be read, no timers started and no network touched until it calls something.

`npm link` puts `agent-harness` on your PATH. It creates a symbolic link from npm's global `bin` folder to your `src/cli/main.js`, and makes the file executable. Because it's a link, every edit to your code takes effect the next time you run the command.

**The link changes how `main.js` knows it's the program.** `main.js` runs its CLI only when it's the program being executed, not when a test imports it. Python contrast: this is `if __name__ == '__main__':`. JavaScript has no such variable, so the reference compares its own URL with the path of the program Node started. Through `npm link`, that path is the link, not the file, so it must be resolved first:

```js
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) { … }
```

Without `fs.realpathSync`, the linked `agent-harness --version` prints nothing and exits 0. The two paths never match, so `main()` never runs.

## Build

### 26.1 `src/config/settings.js` — Core

```js
export const DEFAULT_SETTINGS = deepFreeze({ … });                 // concept 2
export function loadSettings({ cwd, home, flags, onWarn }) { … }   // → { settings, files }
// /model persists defaultModel to YOUR file:
export function saveGlobalSetting(key, value, { home }) { … }
```

Inside: a `SCHEMA` (key → check + description), a `PROJECT_RULES` allow-list (key → `'set' | 'lower' | 'intersect' | 'union' | 'stricter'`), `flatten()` (nested keys become `a.b`, and blocked keys are skipped), and `setPath`/`getPath`.

Some hints:
- **`flatten` turns a layer into key–value pairs:** `{ a: { b: 1 }, c: [1] }` becomes `[['a.b', 1], ['c', [1]]]`. Arrays and `null` are values, not objects to descend into. Then every layer is a loop over pairs, and each pair is checked against `SCHEMA` (and, for a project, `PROJECT_RULES`).
- **Keep `mcpServers` whole.** Its keys are your server names, not settings, so validate and copy it as one object.
- **`'lower'` with no current value** takes the project's: a project may set `compaction.contextLimit` when yours is `null`.
- **`saveGlobalSetting`** reads *your* file, sets one key, and writes it back. It never touches the project's file.

### 26.2 `src/config/logger.js` and `error-handler.js` — Core

`createLogger({ file, level, now })` → `{ child(module) → { debug, info, warn, error }, setLevel }`. Then `categorizeError(err)`, `formatError(err, { logFile })` and `installErrorHandler({ logger, logFile, shutdown, stderr })` → uninstall.

Some hints:
- **`now` is injected** so the test can fix the clock and compare a whole line: `[2026-10-01T09:12:44.123Z] [info] [agent-loop] turn 2 ⏎ finished`.
- **Check the size before each write**, and rename when it's over 1 MiB. The test fills the file past the limit, then expects the next line to start a new file.
- **`installErrorHandler` returns its own undo,** like Day 14's `bus.on()`, so a test can install the handler and remove it again.

### 26.3 `src/cli/main.js` — Core

`export async function main(argv, { env, cwd, stdin, stdout, stderr })` returns an exit code, which makes it testable. Steps:
1. `parseArgs` with the full flag list;
2. help or version;
3. logger;
4. `loadSettings`;
5. `createProvider`, including `provider: 'scripted'` with `--script file.json` for tests, evals and the demo;
6. then either `runPrint` (`app.runOnce(prompt)`; stdout gets only the answer, everything else goes to stderr; exit 3 or 4 as in concept 5) or interactive (`createApp(...).start({ resume })`).

Add a headless `runOnce(prompt, { resume, signal })` to `createApp`, and wire `persistModel` into `/model`.

Some hints:
- **`parseArgs` is Day 5's parser.** The flag list is data, and `--help` prints it, so every flag documents itself. Its first lines:

  ```
  Usage: agent-harness [options] [prompt]

  A terminal coding agent you built in 30 days.

  Options:
    -p, --print                 One-shot: answer the prompt on stdout and exit (tools needing approval …
    -c, --continue              Continue the most recent session in this folder
  ```
- **In print mode, create the app with** `output: stderr`, `input: Readable.from([])` and `terminal: false`. The UI's lines then go to stderr, and nothing waits for typed input.
- **Count denials from `result.toolCalls`**, where each denied call has `denied: true` (concept 5). `result.warning` is set when `maxTurns` ran out.
- **Say why calls were denied.** Day 20's gate returns `{ approved: false, by: 'policy', reason }` for every refusal. Add `unanswered: true` to the non-interactive one, and let the loop copy it into the denial's `details` and the tool log. Then the warning can tell "nobody could approve" from "your rules or mode refused" by a field, never by the reason's text (Day 12).
- **`--resume` needs a fourth start mode**, `'pick'`, which runs Day 19's `/resume` picker at startup.
- **The tests run the real CLI** with `spawnSync`, with `AGENT_HARNESS_HOME` set to a temp folder (Day 17's `configDir` reads it), so your own settings are never touched.

### 26.4 Packaging — Core

`bin`, `exports`, `files`, `engines`; `src/index.js`. Then `npm link`, and `agent-harness --version` from any directory.

The check, from a folder outside the project:

```
$ cd /tmp && agent-harness --version
0.1.0
```

### 26.5 Course tests — Core

Copy `course-tests/day-26/`. It covers:
- frozen defaults; precedence;
- **a project file trying all eight loosening keys, each refused by name**;
- project tightening (deny union, read-only, tool intersection, cap lowering);
- prototype pollution and type errors; flags; logger format and rotation; error categories;
- **a project that can only lower `contextWindow` and `maxTurns`**, with the model choice announced;
- the real CLI as a process: help, version, exit 2, **a clean stdout in `-p`**, **`-p` failing closed (exit 4, with the denial counted) even when the repo sets `autoApprove`**, and `--auto-approve` opting in;
- the package surface.

Commit `day-26: CLI, settings, logging, packaging`.

### 26.6 `--output json` — Stretch

`-p --output json` prints `{ response, turns, toolCalls, usage, aborted }` as one JSON line. That's what Day 29's eval runner would love to parse.

## Check

- [ ] `node --test tests/course/day26-*` green (15 tests)
- [ ] `agent-harness -p "…"` works from any directory after `npm link`
- [ ] The repo-`autoApprove` attack is refused with a warning
- [ ] Commit `day-26: …`

Solution: `src/config/settings.js`, `logger.js`, `error-handler.js`, `src/cli/main.js` and `src/index.js` in [`solutions/final/`](solutions/final/).

## Stuck?

<details><summary><code>-p</code> output contains tool lines</summary>

In print mode, create the app with `output: process.stderr`. The UI's status lines go there, and only `result.response` goes to stdout.
</details>

<details><summary>The process won't exit after <code>-p</code></summary>

Something still holds the event loop: an MCP child, a timer, or a readline. Call `app.stop()` in a `finally`, and give `createApp` an empty input stream (`Readable.from([])`) in print mode.
</details>

<details><summary>Deep merge clobbers <code>compaction</code></summary>

`{ ...defaults, ...file }` is shallow. Flatten to dotted keys and set them one at a time.
</details>

<details><summary>After <code>npm link</code>, <code>agent-harness</code> prints nothing and exits 0</summary>

Your "am I the program?" check compares `import.meta.url` with the path of the link, which never matches. Resolve `process.argv[1]` with `fs.realpathSync` first (concept 6).
</details>

<details><summary><code>./src/cli/main.js</code> says permission denied</summary>

The file isn't executable yet. `npm link` sets the bit for you; before that, run `chmod +x src/cli/main.js`, or start it with `node src/cli/main.js`.
</details>

<details><summary><code>ERR_PACKAGE_PATH_NOT_EXPORTED</code> when importing from the package</summary>

`exports` lets other code import only `agent-harness` itself, which is `src/index.js`. Export what's needed from `src/index.js`, rather than importing a deep path.
</details>

## Common mistakes

- A deny-list for the project layer. You'll forget the next dangerous key.
- Calling `contextWindow` "harmless": it's memory on the user's machine.
- `-p` exiting 0 after denying the very tool calls the prompt asked for.
- Logging to stdout "for convenience".
- `process.exit()` while stdout is still flushing.
- An API key in a settings file, instead of the name of the variable that holds it.
- Async log writes in an error handler, which never happen once the process exits.
- Merging repository JSON without skipping `__proto__`, `constructor` and `prototype`.

## Self-check

1. A global file sets `compaction.keepMessages: 9`, the project sets `tools.enabled: ['read']`, and the CLI passes `--tools read,bash`. What do you end up with?
2. Why is the project layer an allow-list, and why are ignored keys reported by name?
3. Why must logs never go to stdout?
4. What does `-p` do when the model asks for `bash`, and how do you opt in?

Answers: [self-check-answers.md](self-check-answers.md#day-26).

## Further reading

- Node.js, [`process.exitCode`](https://nodejs.org/api/process.html#processexitcode) · [`'uncaughtException'`](https://nodejs.org/api/process.html#event-uncaughtexception) · [package.json `bin`](https://docs.npmjs.com/cli/configuring-npm/package-json#bin)
- [Command Line Interface Guidelines](https://clig.dev/)
- Node.js, [A note on process I/O](https://nodejs.org/api/process.html#a-note-on-process-io): when writes to stdout are synchronous, and when they aren't
- Node.js, [Package `exports`](https://nodejs.org/api/packages.html#exports) · npm, [`npm link`](https://docs.npmjs.com/cli/commands/npm-link)
- MDN, [JavaScript prototype pollution](https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/Prototype_pollution)

---
← [Buffer 2](buffer-2.md) · [Curriculum home](README.md) · Next: [Day 27 — Red-team day](day-27.md) →
