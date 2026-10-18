# Day 23 — MCP: Tools from Any Server ⚠ heavier day

**Phase:** Week 4 — Power & context

## By tonight

```
$ AH_MCP_CONFIG=mcp.json node src/cli/main.js
  · mcp notes: 4 tools (modern protocol 2026-07-28)
> Save a note that says: call mom on sunday. Then list my notes.
  ⚙ mcp__notes__add_note {"text":"call mom on sunday"}
  allow mcp__notes__add_note {"text":"call mom on sunday"}? [y]es / [N]o / [a]lways this session a
  ⚙ mcp__notes__list_notes {}
  allow mcp__notes__list_notes {}? … a
agent> Done! I've saved a note that says "call mom on sunday". Your notes list now contains:
1. call mom on sunday
```

The first line after startup is your client reporting on a server it has just started: the server is called `notes`, it offers four tools, and it speaks the modern protocol. The `⚙` lines show those tools under new names, `mcp__notes__…`, so they can't collide with anyone else's. Each one asks for approval, because a tool from someone else's server is treated as untrusted until you say otherwise, and here each was answered `a`, which allows that one tool for the rest of the session.

Your harness can now use tools from **any** MCP server (thousands exist) through a client you wrote yourself: a child process and some JSON-RPC.

## Why it matters

Since yesterday the harness can load extensions: other people's code, running inside your own process, behind a trust prompt. MCP brings in other people's tools a different way. Their code runs in a separate program, and your harness only ever talks to it through a pipe.

The **Model Context Protocol** is how tools are shared between harnesses now. A server written once (for GitHub, a database, a browser, your company's API) works in Claude Code, Codex, Cursor, VS Code, and from tonight, yours. The spec moved to a **stateless** design in revision `2026-07-28`. Building a client teaches you JSON-RPC, child-process protocols, cancellation, and why "a server's description of its own tool" is untrusted input.

(Pi deliberately ships *without* MCP; Mario Zechner's post explains why. You're adding it because it's now the standard. Hold both views on Day 30.)

## Concepts

### 1. Transport: stdio, one message per line

An MCP server is a program that offers tools, and your harness is the *client*. The client **spawns** the server as a child process, the way Day 11's `bash` tool starts `sh`, and talks over its stdin and stdout: requests go into the server's stdin, and replies come out of its stdout. There's no network and no port. The connection is two pipes.

You can play the client yourself. Build one request with `JSON.stringify`, pipe it into the course server (23.1 copies it into `examples/mcp/`), and read what comes back:

```
$ node -e 'console.log(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {},
              clientInfo: { name: "me", version: "0" } },
  }))' | node examples/mcp/notes-server.mjs --legacy
[notes-server] ready (legacy only)
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},…}}
```

One line went in, and one line came back. The `ready` log went to stderr, and the reply (shortened here) went to stdout. When the input ended, the server exited. Those three observations are the transport's three rules.

**Rule 1: one message per line.** Each message is one JSON-RPC 2.0 object followed by `\n`, with no newlines inside it. `JSON.stringify` never produces a raw newline: a newline inside a string comes out as the two characters `\` and `n`.

```js run
const line = JSON.stringify({ text: 'line one\nline two' });
line.includes('\n')   // → false
console.log(line);    // {"text":"line one\nline two"}
```

The trailing `\n` is part of the message. The server reads lines, so a message written without it waits in the server's buffer, unanswered. In the other direction, stdout arrives in chunks that don't line up with messages, so framing is your Day 4 NDJSON parser again: buffer until a newline, then parse.

**Rule 2: stdout carries protocol messages only.** The server writes **only** protocol messages to stdout, and logs to stderr. One stray `console.log('starting…')` in a server puts a line of plain text into the stream, and the client can't parse it. The spec also says a client shouldn't take stderr output as a sign of an error: servers log there for every reason, so your client passes those lines to `onLog` and carries on.

**Rule 3: say goodbye by closing stdin.** To shut down, **close the server's stdin**, wait, then SIGTERM, then SIGKILL. A well-behaved server sees the end of its input and exits. The course server's last lines do exactly that (`rl.on('close', () => process.exit(0))`), which is why the `node -e` pipe above ended on its own. For a server that ignores it, you escalate with Day 11's signals: `SIGTERM` ("please stop"), then `SIGKILL` ("stop now").

Python contrast: this is `subprocess.Popen(cmd, stdin=PIPE, stdout=PIPE, stderr=PIPE)`, with `proc.stdin.close()` as the polite goodbye.

The pipes carry lines. What goes in each line is JSON-RPC.

### 2. JSON-RPC in five lines

JSON-RPC is a small convention for calling a function on the other side. It works over any channel that carries messages, and MCP uses version 2.0. Every message carries `"jsonrpc":"2.0"`, and there are three kinds:
- a **request** has an `id`, a `method` and `params`, and gets exactly one reply;
- a **response** carries the same `id`, and either a `result` or an `error` (a numeric `code` and a `message`);
- a **notification** has a `method` and `params` but **no `id`**, and gets no reply.

All three in one conversation (→ is client to server, ← is server to client; the messages are shortened to the fields that matter here, and concept 3 adds the `_meta` that modern servers require):

```
→ {"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"add_note","arguments":{"text":"hi"}}}
← {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"Saved note #1."}],"isError":false}}
← {"jsonrpc":"2.0","id":8,"error":{"code":-32602,"message":"Unknown tool: nope"}}
→ {"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9,"reason":"timeout"}}
```

The first two lines are a request and its result. The third is the reply to a request for a tool that doesn't exist. The last has no `id`, so it's a notification: the client tells the server something and expects nothing back.

Replies can come back in any order. A server may work on several requests at once and answer whichever finishes first. Send the course server a slow `sleep` (id 1) and then a quick `add_note` (id 2), and the answers arrive as 2, then 1:

```
→ {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sleep","arguments":{"ms":300},…}}
→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add_note","arguments":{"text":"hi"},…}}
← {"jsonrpc":"2.0","id":2,"result":{…}}
← {"jsonrpc":"2.0","id":1,"result":{…}}
```

So you match replies by `id`. Requests carry an `id`, and you match replies to requests with a `Map<id, { resolve, reject, timer }>`. That's the same promise-per-id pattern as Day 20's approval gate, where `pending` mapped a tool call's id to its resolver, and Day 20's help-desk example showed it with a timeout and an abort. Without the timer and the abort (concept 6 adds them), the pattern is this:

```js
const pending = new Map();                           // id → { resolve, reject }
let nextId = 1;

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ jsonrpc: '2.0', id, method, params });   // one line on the server's stdin
  });
}

function onMessage(msg) {                            // once per line parsed from stdout
  const p = pending.get(msg.id);
  if (!p) return;                                    // nobody is waiting for this id any more
  pending.delete(msg.id);
  if (msg.error) p.reject(new McpError(msg.error.message, { code: msg.error.code }));
  else p.resolve(msg.result);
}
```

Notice what each half does, and when. `request` runs once per call: it stores the promise's two settle functions, writes one line, and returns a pending promise straight away, so nothing waits. `onMessage` runs later, once for every line the parser takes out of stdout, in whatever order the server answers. The map is the only thing connecting the two, which is why every way a request can end (a reply, an error, a timeout, an abort, a dead server) has to remove its entry.

C++ contrast: the table is a `std::unordered_map<int, std::promise<Json>>`, and each reply fulfils one promise.

Error codes are numbers. JSON-RPC defines a few: `-32700` (the line wasn't valid JSON), `-32601` (no such method), `-32602` (invalid params) and `-32603` (an internal error). It leaves `-32000` to `-32099` for implementations, and MCP uses that room for its own errors, such as concept 3's `-32022`. The course server answers an unknown tool name with `-32602`, as in the third line of the first conversation.

Those are the messages. Which message a server expects first depends on which version of MCP it speaks.

### 3. Two eras of MCP: be "dual-era"

The protocol changed shape in 2026. Before revision `2026-07-28` (the *legacy* era), a connection began with a handshake. The client sent an `initialize` request with its protocol version and capabilities, the server answered with its own, and the client confirmed with a `notifications/initialized` notification. Only then could real requests flow, and the server remembered the agreement for as long as the connection lasted.

The *modern* era drops the handshake. Each request carries what the handshake used to establish, inside `params._meta`. Here is a real `tools/call` from the reference client, pretty-printed (on the wire it's one line):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "add_note",
    "arguments": { "text": "hi" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "agent-harness", "version": "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

The differences, side by side:

| | **Modern** (`2026-07-28`) | **Legacy** (`2025-11-25` and earlier) |
|---|---|---|
| Start-up | none. `server/discover` is optional | `initialize` request, then `notifications/initialized` |
| Every request | carries `_meta`: `io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities` (required), `…/clientInfo` | plain params |
| State | none: each request stands alone | a session per connection |

Many servers are still legacy, so the client probes. It can't know a server's era in advance, so `start()` asks:
1. send `server/discover` (with modern `_meta`), with a short timeout;
2. a `DiscoverResult` means modern;
3. a `-32022 UnsupportedProtocolVersion` error means modern, and you pick from `data.supported`;
4. **any other error, or no answer**, means legacy, so fall back to `initialize`.

These are the course server's real answers to a probe (shortened):

```
# dual-era server: a DiscoverResult, so modern
← {"jsonrpc":"2.0","id":1,"result":{"supportedVersions":["2026-07-28","2025-11-25"],…}}

# the same server, probed with a version it doesn't know (2027-01-01): still modern
← {"jsonrpc":"2.0","id":2,"error":{"code":-32022,…,"data":{"supported":["2026-07-28","2025-11-25"],…}}}

# started with --legacy: Method not found, so fall back to initialize
← {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found: server/discover"}}
```

Why does the probe get its own short timeout? The legacy course server rejects `server/discover` at once, so falling back costs one round trip. A server that ignores the unknown request and stays silent is different: the probe learns nothing until its timer runs out. That's why the probe uses `probeTimeoutMs` (2 s) and not the 30-second request timeout.

After the probe, every request follows the era. `request()` adds `_meta` when the era is modern, and sends plain params when it's legacy. The course server enforces this. A request with neither `_meta` nor a finished `initialize` gets `{"code":-32602,"message":"request without _meta before initialize"}`, so a passing modern test proves you sent `_meta`.

With the era settled, the client can ask what the server is for: its tools.

### 4. Tools: list, call, results

`tools/list` is the menu. Its tool definitions look almost like Day 9's: a `name`, a `description`, and a JSON Schema for the arguments. MCP calls the schema `inputSchema`, and your registry calls it `parameters`. One of the course server's four tools:

```json
{
  "name": "add_note",
  "title": "Add note",
  "description": "Save a short text note. Returns the note number.",
  "inputSchema": {
    "type": "object",
    "properties": { "text": { "type": "string", "description": "The note text" } },
    "required": ["text"]
  }
}
```

The full reply is `{ tools: [{ name, title?, description, inputSchema }], nextCursor? }`. A server with many tools sends them a page at a time. Keep fetching while there is a `nextCursor`, passing it back as `cursor`:

```
tools/list {}                  → { tools: [ …first page… ], nextCursor: 'p2' }
tools/list { cursor: 'p2' }    → { tools: [ …last page… ] }        ← no nextCursor: done
```

A `do … while` loop fits, because you always fetch at least once. Python contrast: Python has no `do … while`, so there you'd write `while True:` and `break` when the cursor is missing.

`tools/call` returns a list of content items. The shape is `{ content: [{ type: 'text', text } | image | resource…], isError, structuredContent? }`. Your client's `callTool('add_note', { text: 'hi' })` resolves to:

```js
{ content: [{ type: 'text', text: 'Saved note #1.' }], isError: false, structuredContent: { number: 1 } }
```

`content` can hold several items, and not all of them are text: there are `image` and `audio` items (base64 data), `resource_link` items (a URI) and `resource` items (an embedded file). `structuredContent` is the same answer as JSON, for programs rather than models. Your tools hand the model text, so 23.3 turns each item into text, and describes an image rather than pasting thousands of base64 characters into the context.

There are two kinds of failure, and they arrive in two different ways:
- **Protocol errors** (a JSON-RPC `error`: unknown tool, bad params) are exceptions. The request itself was wrong. `callTool('nope', {})` rejects with an `McpError` whose `code` is `-32602` and whose message is `Unknown tool: nope`.
- **Tool errors** (`isError: true`) are *results* the model should see, like ours. The tool ran and failed, and its message is written for the model, as Day 9's results are. `callTool('fail', {})` resolves to `{ content: [{ type: 'text', text: 'this tool always fails' }], isError: true }`.

The model should see both, and neither should crash a run. So the adapter's `execute` (23.3) catches the protocol error and returns it as an error result, keeping Day 12's rule that a tool call never throws. The model then reads `MCP notes/nope failed: Unknown tool: nope`.

The server may also have a question first. A `resultType: "input_required"` reply means the server wants to ask the user something before it can finish (this is *elicitation*). Our client reports that as unsupported, as an `isError` result, which is a good Stretch (23.7).

A tool list and a way to call it would be enough to plug MCP straight into the registry. What stops us doing that naively is that every word in that list came from the server.

### 5. MCP tools are untrusted guests

A server is someone else's code, describing itself. Its tool names, descriptions and hints are all the server's own claims. So each server tool becomes a harness tool with guards around it.

The first guard is the name. Each tool is registered as `mcp__<server>__<tool>`, so two servers' `search` tools can't collide. The server part is the name *you* gave it in your config, not one the server picked. Characters outside `A-Z a-z 0-9 _ . -` become `_`, and the whole name is cut to 64 characters:

```js
mcpToolName('notes', 'add_note')            // → 'mcp__notes__add_note'
mcpToolName('my server', 'search notes')    // → 'mcp__my_server__search_notes'
mcpToolName('git', 'git.log')               // → 'mcp__git__git.log'
```

The second is approval: every MCP tool has `needsApproval: true` by default. The spec says hosts must obtain consent before invoking tools, and that annotations like `readOnlyHint` are **untrusted** unless the server is. A server can mark a tool `annotations: { readOnlyHint: true }`, but with `trustReadOnlyHints` at its default of `false`, the tool still asks first. The option exists for a server you trust; nothing stops a hostile server from labelling every tool read-only.

The third is a label. Each description is prefixed `[MCP server "notes"]`, so you and the model can see where it came from: `[MCP server "notes"] Save a short text note. Returns the note number.` A malicious server can put prompt injection in its descriptions; Day 27 tests that.

The fourth is where servers come from: they're configured in *your* global settings only (Day 26). Starting an MCP server *runs a program*, so a repo must never be able to add one. Day 22 asks before loading a project's extensions. MCP servers go further: a project's settings can't name one at all. Day 26's loader ignores `mcpServers` in a project file, with a warning, and Day 27 checks that it does.

The fifth is what the server can see. It's started with a safe, minimal environment. A child process inherits whatever env you give it, and Node's `spawn` gives it all of `process.env` unless you pass `env`. Handing it everything would leak your shell's secrets (API keys, this harness's own provider key) into a program you may barely know. Pass a short baseline (`PATH`, `HOME`, …) plus only what the server's config names, as the official SDK does:

```js
defaultEnv({ HOME: '/home/me', PATH: '/usr/bin', OPENAI_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_x' })
// → { HOME: '/home/me', PATH: '/usr/bin' }
```

The server's configured `env` is laid on top (`{ ...defaultEnv(), ...this.env }`), so secrets a server needs come from its configured `env`: one named key, not your whole shell. Python contrast: `subprocess.Popen` works the same way. With no `env=` argument, the child inherits everything.

The last guard is about names again, defensively this time. Two of a server's tools can collide after sanitizing (`search notes` and `search_notes` both become `…__search_notes`). Skip the duplicate with a warning rather than throwing. One odd tool must not take the whole server down, which would leave its other tools bound to a client you then close. The warning names both:

```
mcp notes: skipping tool "search notes" — name "mcp__notes__search_notes" is already taken
```

That covers what a server can claim. The last concept is about what happens when a server is slow, or stops answering altogether.

### 6. Cancellation and timeouts

A request can end in three ways besides a reply. The user aborts (Ctrl+C fires the run's `AbortSignal`, Day 3), the timer runs out (`requestTimeoutMs`, 30 s by default), or the server process dies. Whichever happens, the waiting promise must settle, or the run hangs.

On abort or timeout, the client does three things. It cleans up the pending entry (delete it from the map, clear the timer, remove the abort listener). It sends `notifications/cancelled { requestId, reason }`, so the server can stop working. Then it rejects the local promise. These are the real lines your client writes for an aborted `sleep` and a timed-out one:

```
{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":6,"reason":"aborted by user"}}
{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7,"reason":"timeout"}}
```

An abort rejects with `signal.reason` (an `AbortError`, unless the abort gave another reason), like every abortable function since Day 3. A timeout rejects with a message that names the method and the limit, such as `MCP tools/call timed out after 100 ms`.

A cancellation is a request, not a guarantee. The server should stop and not reply afterwards, but its reply may already be on the way. So your client ignores a reply whose `id` is no longer pending: that's the `if (!p) return` in concept 2's sketch. The course server's `sleep` checks for cancellation and stays silent, and logs `[notes-server] cancelled 6` to stderr.

If the server dies, everything still pending fails at once. When the server process dies, no reply will ever come for the requests still in the map. Reject every pending request with an error that names the server, such as `MCP server 'notes' exited (SIGKILL)`, and never hang. Remember the error, too: every later request fails with it at once, instead of waiting out its timeout for a reply that can't come. The same goes for start-up. If the server never starts (`could not start MCP server 'x': spawn … ENOENT`) or exits during the probe (`MCP server 'x' exited (code 1)`), `start()` fails with that error rather than falling back to a legacy handshake with a dead process.

Here are those endings together in one general example, a dry cleaner's counter. Every item gets a ticket, items come back when they're ready, and the shop can close early:

```js run
const pending = new Map();                         // ticket → { resolve, reject }
let nextTicket = 1;
let closedReason = null;                           // remembered once the shop has closed

function dropOff(item, readyInMs) {
  if (closedReason) return Promise.reject(closedReason);   // fail at once: no reply can come
  const ticket = nextTicket++;
  return new Promise((resolve, reject) => {
    pending.set(ticket, { resolve, reject });
    setTimeout(() => collect(ticket, `${item} is clean`), readyInMs);
  });
}

function collect(ticket, result) {                 // a reply arrives, with its ticket number
  const p = pending.get(ticket);
  if (!p) return;                                  // nobody is waiting for this ticket any more
  pending.delete(ticket);
  p.resolve(result);
}

function closeShop(reason) {                       // the other side is gone for good
  closedReason = new Error(reason);
  for (const p of pending.values()) p.reject(closedReason);
  pending.clear();
}

const report = (label, promise) => promise.then(
  (result) => console.log(`${label}: ${result}`),
  (err) => console.log(`${label}: failed (${err.message})`),
);

const all = Promise.all([
  report('ticket 1, suit', dropOff('suit', 40)),
  report('ticket 2, shirt', dropOff('shirt', 10)),
  report('ticket 3, coat', dropOff('coat', 80)),
]);
setTimeout(() => closeShop('the shop closed early'), 50);
await all;
await report('ticket 4, scarf', dropOff('scarf', 10));
// → ticket 2, shirt: shirt is clean
// → ticket 1, suit: suit is clean
// → ticket 3, coat: failed (the shop closed early)
// → ticket 4, scarf: failed (the shop closed early)
```

The shirt was dropped off second but was ready first, and its ticket still found the right waiting promise: that's matching by id. At 50 ms the shop closes with the coat still inside, so `closeShop` rejects every promise left in the map, all at once. The coat's own reply turns up at 80 ms, finds no ticket in the map, and is ignored, which is the `if (!p) return` doing its job. And because the closing reason is remembered, the scarf, dropped off after the shop has closed, fails straight away instead of waiting for a reply that can never come. Your client does each of these with its pending map, `#failAll` and its stored "gone" error.

## Build

### 23.1 The course server — Core

`mkdir -p examples/mcp && cp ../agent-harness-curriculum/course-assets/mcp/notes-server.mjs examples/mcp/`. Read it (100 lines). It's dual-era, and `--legacy` makes it legacy-only.

Then talk to it by hand with the `node -e` command from concept 1, before you write any client. As you read, find where it logs (stderr only), how `sleep` notices a cancellation, and where it rejects a modern request without `_meta`.

### 23.2 `src/mcp/mcp-client.js` — Core

```js
export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSION = '2025-11-25';

export class McpError extends Error { /* code, data */ }

export class McpClient {
  constructor({
    name, command, args, env, cwd,
    requestTimeoutMs = 30_000, probeTimeoutMs = 2_000,
    clientInfo, onLog,
  }) { … }
  async start() { … }        // spawn; NdjsonParser on stdout; stderr → onLog; era detection (concept 3)
  async listTools() { … }    // follows nextCursor
  async callTool(name, args, { signal }) { … }           // → { content, isError, structuredContent? }
  request(method, params, { signal, timeoutMs }) { … }   // adds _meta when modern
  async close({ graceMs }) { … }                         // stdin.end → wait → SIGTERM → SIGKILL
}
```

Spawn the child with a **minimal environment** (`defaultEnv()` — a safe baseline plus the configured `env`), never the full `process.env`. The heart of it is a private `#request(method, params, { signal, timeoutMs, version, legacy })`:
- it allocates an id and stores `{ resolve, reject, timer }`;
- on timeout or abort, it cleans up, sends `notifications/cancelled`, and rejects;
- `#onMessage` resolves or rejects by id;
- on `exit`, `#failAll` rejects everything still pending.

Some hints:
- **What the tests read.** After `start()`, the client exposes `era` (`'modern'` or `'legacy'`), `protocolVersion`, `serverInfo` and `instructions`, and keeps the process in `child` (the crash test kills it). A modern server sends `serverInfo` in the `_meta` of its `server/discover` result, and a legacy one in its `initialize` result. Export `defaultEnv` too: the tests call it with a fake environment object.
- **Two ways in.** The public `request()` fills in `version` and `legacy` from the era. The probe and the `initialize` handshake call `#request` directly, because the era isn't known yet.
- **Listen before you talk.** Attach the stdout parser and the `exit` and `error` handlers right after `spawn`, before the first request, so an early crash can't slip past them.
- **Keep the cause of death.** Store the first `exit` or `error` as the client's "gone" error. `#request` checks it first, and the probe's `catch` rethrows it instead of trying the legacy handshake. The course test kills a server and then expects the next request to fail within a second.

Listening early matters because of two facts about Node's events. An event emitted while nobody is listening is gone: Node doesn't keep it for a listener that subscribes later. We tried it, and a listener attached after an `await` never heard the `exit` of a child that had already finished. And a child that can't start emits `'error'`, and an `'error'` event with no listener throws, so `spawn('no-such-program')` with no handler crashes the whole harness with `Unhandled 'error' event`. Attaching every handler in the same synchronous stretch as `spawn` is safe, because Node delivers these events only after that stretch of code has finished.

### 23.3 `src/mcp/mcp-tools.js` — Core

`registerMcpTools(registry, client, { trustReadOnlyHints = false, onWarn })` → `{ names, unregister }` (concept 5). Skip a tool whose namespaced name is already taken (warn, don't throw). Render content items to text:
- `text` passes through;
- `image`/`audio` become a one-line description;
- resources become their text or URI.

Then run everything through `truncateText`.

For example, the reference renders an image item as `[image image/png, 1000 base64 chars — not shown]`, and a `resource_link` as `[resource README file:///…]`. Some hints:
- **Export `mcpToolName(server, tool)`** as well; the tests import it.
- **Call the server by its own name.** `execute` calls `client.callTool(t.name, …)` with the tool's original name, such as `add_note`. The namespaced name exists only inside your harness.
- **Catch inside `execute`.** Turn a rejected `callTool` into `{ content: …, isError: true }` with the server's message (concept 4).

### 23.4 Wire it, plus `/mcp` — Core

`createApp({ mcpServers: { notes: { command: 'node', args: ['examples/mcp/notes-server.mjs'] } } })` connects every server at startup. **One failing server never blocks the others.** It registers their tools, lists them with `/mcp`, and closes them on quit. Until Day 26's settings file exists, `src/cli/main.js` reads `AH_MCP_CONFIG=mcp.json`.

`mcp.json` holds the same object as `mcpServers`:

```json
{
  "notes": { "command": "node", "args": ["examples/mcp/notes-server.mjs"] }
}
```

With it, the reference's `/mcp` answers with one line per server, and a server that can't start gets one line at startup while the rest carry on:

```
> /mcp
  · notes (modern 2026-07-28): mcp__notes__add_note, mcp__notes__list_notes, mcp__notes__sleep, …
```

```
  · mcp broken failed to start: …
```

### 23.5 Course tests and live — Core

Copy `course-tests/day-23/`. It covers:
- modern discovery; list and call (the server *rejects* requests without `_meta`, so passing proves you send it);
- legacy fallback; `isError` results; abort with `cancelled`; timeouts; a server crash; `close()`;
- `defaultEnv` passing a safe baseline but no secrets; two tools that collide being skipped with a warning (not a throw);
- registration (names, approval, description prefix); a full loop run.

The tests start the course server as a real child process, so they need `examples/mcp/notes-server.mjs` from 23.1.

Then do *By tonight* live. Commit `day-23: MCP client`.

The full loop run is the test to watch. It sends an MCP tool call through the same `AgentLoop` and the same tool-result path as every built-in tool (with an approver that always says yes), which is the proof that a server's tools really are just tools to the rest of the harness. The live run is where your real approval gate asks.

### 23.6 A real server — Stretch

Add a real community MCP server to your `mcp.json`, for example a filesystem or git server from the [MCP servers list](https://github.com/modelcontextprotocol/servers). Which era does it speak? How many tools, and how many tokens do their schemas cost (Day 24)? Read its tool descriptions as an attacker would.

### 23.7 Elicitation — Stretch

Handle `resultType: "input_required"` with an `elicitation/create` form request: ask each field through `ui.ask`, then retry the call with `inputResponses` and `requestState` (and a **new** JSON-RPC id).

## Check

Your harness now has a client for a protocol thousands of servers speak. It starts each server as a child process, frames its stdout as lines, and matches every reply to its request by id, in whatever order the replies come. A short probe tells it each server's era, and it speaks to each one accordingly. Every way a request can end settles its promise exactly once: a reply, a timeout, an abort with a `cancelled` notification, or the server dying, which fails everything still pending at once. And every tool a server offers arrives as an untrusted guest: renamed, labelled, asking for approval, and running with only the environment you chose to give it.

Tomorrow, [Day 24](day-24.md) turns to what all these tools cost: the context window, which tool schemas, the system prompt and the history all have to share.

Before you move on, check:

- [ ] `node --test tests/course/day23-*` green (12 tests)
- [ ] Live: an MCP tool runs through your approval gate
- [ ] `notes/tool-security.md` "Day 23" section: MCP servers run code, descriptions are untrusted, global config only
- [ ] Commit `day-23: MCP client`

Solution: `src/mcp/` in [`solutions/checkpoint-3/`](solutions/checkpoint-3/).

## Stuck?

<details><summary>Every request after the probe fails with <code>-32602</code> about <code>_meta</code></summary>

You decided the server was modern but aren't adding `_meta` to later requests. `request()` must add it whenever `this.era === 'modern'`.
</details>

<details><summary>The legacy test waits 30 s</summary>

Your probe uses the normal request timeout. Use the short `probeTimeoutMs`, and treat *any* non-modern error as "legacy".
</details>

<details><summary>Replies get matched to the wrong request</summary>

Ids must be unique among in-flight requests. Use an incrementing counter and delete the map entry on resolve, reject, timeout and abort, in **one** cleanup function.
</details>

<details><summary>The server never answers, not even the probe</summary>

Check that every message ends with `'\n'`: write `JSON.stringify(msg) + '\n'`. The server reads whole lines, so without the newline your request waits in its buffer. If you're testing your own server, check that it doesn't print anything but protocol messages to stdout.
</details>

<details><summary>The abort test fails: it expected an <code>AbortError</code></summary>

Reject with `signal.reason`, not with an error of your own. The test aborts with no reason, so `signal.reason` is the `AbortError` it expects.
</details>

<details><summary>Live, the harness says <code>mcp notes failed to start</code></summary>

The message says why, such as `exited (code 1)` or `spawn … ENOENT`. The `args` path in `mcp.json` is relative to the folder you start the harness in. Run the same command yourself from that folder (`node examples/mcp/notes-server.mjs`). A working server logs `[notes-server] ready (dual-era)` and waits for input (Ctrl+D ends it). The app doesn't show a server's stderr, so this is the quickest way to see its real error.
</details>

## Common mistakes

- Reading stdout chunk-by-chunk as whole messages (frame it!). In a quick test each reply is small and arrives in one chunk, so the bug waits for a long reply or a busy server.
- Writing a message without its trailing newline. `JSON.stringify` doesn't add one, and the request waits in the server's buffer with no error on either side.
- Trusting `readOnlyHint` and skipping approval. The hint looks like metadata, but it's the server's own claim about itself.
- Handing the server your whole `process.env` (secrets and all). That's what `spawn` does when you don't pass `env`, so it's the default you get by doing nothing.
- Throwing on a tool-name collision, which leaves half a server's tools registered against a dead client. Throwing feels like the strict, safe choice, but it fails halfway through a loop that has already registered tools.
- Letting a project config start MCP servers. A server entry looks like configuration, but starting it runs a program.
- Sending `notifications/cancelled` but leaving the request in the pending map, or its timer running. Cancelling feels finished once the notification is sent, but your own side still has its cleanup to do.
- Treating any stderr output as a failure. Servers log there for every reason. Stderr sounds like "errors", but for a stdio server it's the only place left to log.

## Self-check

1. What changed between legacy and modern MCP, and how does a dual-era client tell them apart?
2. Protocol error vs tool error: how is each delivered, and what does the model see?
3. Why are MCP tools `needsApproval` by default, even when the server says "read-only"?
4. What must happen to pending requests when the server process dies?

Answers: [self-check-answers.md](self-check-answers.md#day-23).

## Further reading

- [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28): [stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) · [versioning & compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) · [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) · [discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) · [cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation)
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification): short enough to read in full, including the table of error codes
- [MCP servers repository](https://github.com/modelcontextprotocol/servers)
- MCP, [Security best practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices): the risks behind concept 5, from the spec's authors
- Node.js, [child_process](https://nodejs.org/api/child_process.html): `spawn`'s `env` and `stdio` options

---
← [Day 22](day-22.md) · [Curriculum home](README.md) · Next: [Day 24 — Context: budgets, prompts, AGENTS.md, skills](day-24.md) →
