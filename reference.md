# Reference

The contracts every module shares, the glossary, the troubleshooting table, and a map of Pi, the harness you read on Day 6. You don't need to read this page before you start. Each day links to the part it uses, on the day it uses it.

**Contents:** [Canonical contracts](#canonical-contracts) · [Glossary](#glossary) · [Troubleshooting](#troubleshooting) · [Pi's architecture](#pis-architecture)

---

## Canonical contracts

These are fixed early and reused everywhere, and every day that uses one links here. **Do not invent a second vocabulary.**

### Canonical event list

Defined once in `src/shared/events.js` (Day 14). The UI, bridge, loop, extensions and tests all import from there.

**Agent / core → bus**

| Event | When | Payload |
|---|---|---|
| `session_start` | Session created or resumed | `{ sessionId }` |
| `session_shutdown` | Quit / unload | `{ sessionId }` |
| `agent_start` | `run()` begins | `{ userMessage }` |
| `turn_start` | About to call the provider | `{ turn }` |
| `turn_end` | Provider call and its tools finished | `{ turn, usage? }` |
| `thinking_delta` | Streaming reasoning chunk | `{ content }` |
| `text_delta` | Streaming answer chunk | `{ content }` |
| `tool_call_start` | About to execute a tool | `{ id, name, arguments }` |
| `tool_approval_request` | Tool needs a human decision | `{ id, name, arguments }` |
| `tool_approval_result` | Human (or timeout/abort) decided | `{ id, approved, remember? }` |
| `tool_call_end` | Tool finished (success or error) | `{ id, name }` |
| `tool_result` | Result ready for history | `{ id, name, content, isError }` |
| `agent_end` | `run()` finished, on every exit path | `{ response, turns, aborted }` |
| `compaction` | History was compacted | `{ dropped, kept }` |
| `error` | Recoverable or fatal error | `{ message, cause? }` |
| `command_run` | Slash command executed | `{ name, args }` |

**UI → bus:** `user_message` `{ content }`, `abort` `{}`, `command` `{ line }`.

There are **no aliases**. Extensions subscribe to these exact names. Pi uses a different vocabulary (see [Pi's architecture](#pis-architecture)). Ours splits a tool call into start / end / result, and gives thinking its own event.

### Message and tool shapes

JSDoc lives in `src/shared/message-schemas.js` (Day 7) and `src/shared/tool-schemas.js` (Day 9).

- **Roles (internal):** `system`, `user`, `assistant`, `tool_result`. How a role maps onto the wire is each provider's private business.
- `AgentMessage` = `{ role, content, thinking?, toolCalls?, toolCallId?, toolName?, isError?, usage? }`
- `ToolCall` = `{ id, name, arguments, parseError? }`:
  - **`id`** is the server's id when it sends one (Ollama 0.32 does: `call_…`). Otherwise the provider generates one. It is never empty.
  - **`arguments`** is always a plain object inside the harness. Providers parse strings at the boundary.
  - **`parseError`** marks wire arguments that were not valid JSON.
- `ToolDefinition` = `{ name, label?, description, parameters /* JSON Schema */, execute(args, { signal }), needsApproval?, readOnly? }`
- `ToolResult` = `{ content, isError, details? }`. **Tool failures are results, not exceptions.**
- `ChatResponse` = `{ content, thinking?, toolCalls, usage?, model, finishReason? }`. `usage` = `{ promptTokens, completionTokens }`.
- `StreamEvent` (from `chatStream`) is one of:
  - `{ type: 'text_delta', content }`
  - `{ type: 'thinking_delta', content }`
  - `{ type: 'tool_call_start', id, name }`
  - `{ type: 'tool_call_delta', id, argsDelta }`
  - `{ type: 'done', response }`, where `response` is the fully assembled `ChatResponse`
- **Provider interface:** `chat(messages, tools, { signal })`, `chatStream(messages, tools, { signal })`, `listModels()`, `getModelInfo(name?)` → `{ name, contextLimit, maxContext, capabilities }`, `setModel(name)`, `model`.

### Tool output truncation contract

The default cap is **32 KiB** of UTF-8. `@file` attachments are capped at 50 KiB per file **and** share a budget of about 40% of the context window (Day 28), because they sit in the newest message, which compaction never touches. A truncated result reads:

```
<actual prefix of output>
...[truncated: showing 32768 of 120004 bytes. Use read with offset/limit or a narrower command to see more.]
```

- Truncation happens **in the harness**. Counts are UTF-8 **bytes** (`Buffer.byteLength`, `Buffer.subarray`, never `String.slice`), and a cut never splits a character (Day 4).
- The advice after the counts is a parameter (`truncateText(text, max, { hint })`). Only suggest tools the model actually has: the week 1 toy has no `read`, so it says `Run a narrower command to see more.`
- Set `details.truncated`, `details.byteLength` and `details.shownBytes`.
- **Command output keeps the head *and* the tail** (`keep: 'head+tail'`, Day 11), because test runners and compilers print their errors and summaries last. The marker sits in the middle: `...[truncated: showing the first 16384 and the last 16384 of 120004 bytes. Use a narrower command (grep, head, tail) to see more.]`
- Never drop the middle silently: the model hallucinates output it never saw.

### Tool-pair history invariant

An `assistant` message with `toolCalls` and **all** of its `tool_result` messages are one unit. They are kept, dropped, or folded into a compaction record **together**, and the latest user message is never dropped.

```json
{ "role": "user", "content": "What files are in /tmp?" }
{ "role": "assistant", "content": "", "toolCalls": [{ "id": "call_1", "name": "bash", "arguments": { "command": "ls /tmp" } }] }
{ "role": "tool_result", "toolCallId": "call_1", "toolName": "bash", "content": "a.txt\nb.txt", "isError": false }
```

Abort keeps the trio too. If the run aborts before a tool runs, its result is still appended (`isError: true`, content `Skipped: run aborted`). After an interrupted run, history gets one more message, `{ role: 'user', content: '[Request interrupted by user]' }`, so the model is less likely to pick up the task you stopped (Day 15). A run that fails partway is saved up to its last complete tool pair.

### Approval & permissions

- **Day 12 (minimal):** `AgentLoop` takes an `approve(call, tool, { signal })` callback. With **no** approver attached, `needsApproval` tools are **denied** (fail closed).
- **Day 20 (full gate):** a permission policy answers `allow`, `deny` or `ask` per call.
  - **Rules:** `"read"`, `"bash(git status)"`, `"bash(npm test*)"`. `*` is a wildcard on the tool's main argument. A **path** argument is normalized against the workspace first (so `./x`, `a/../x` and absolute paths can't dodge a rule), and a **wildcard `bash` allow** rule never matches a command with a shell operator (`; && | \` $( > <`), so `bash(npm test*)` can't pre-approve `npm test; curl … | sh`. **Deny rules always win** (and are not narrowed this way) — but they stop accidents, not a determined command; they are a guard-rail, not a sandbox.
  - **Modes:**
    - `default` asks for every `needsApproval` tool.
    - `read-only` denies anything that is not `readOnly`.
    - `accept-edits` allows `write`/`edit` and asks for `bash`.
    - `yolo` allows everything except deny rules.
  - **The ask path:**
    1. `tool_approval_request` → y/N/a prompt showing the **whole** request, never cut short → `tool_approval_result` for the same `id` (`Map<id, resolver>`).
    2. `a` adds a session rule, scoped as narrowly as the call allows (exact command for `bash`, exact path for `write`/`edit`, tool name otherwise), and the prompt says what it will cover.
    3. **Timeout 120 s → deny**; **abort → deny**.
    4. A human "no" (or timeout/abort) appends `ToolResult { isError: true, content: 'User denied <name>' }`; a policy refusal reads `Denied <name> (<reason>)`. The approver marks policy refusals with `by: 'policy'`; the loop routes on that field, never on the reason's text.
  - **Non-interactive (`-p`) fails closed:** `ask` becomes deny unless you pass `--auto-approve` (mode `yolo`) or allow rules. A harness that silently runs commands because nobody was watching is a liability.

### Trust boundaries

| Boundary | Rule |
|---|---|
| **Workspace jail** | Every file path resolves under the workspace root through `src/tools/workspace-path.js`: a lexical check (`..` as a path segment) **and** a realpath check against symlinks, dangling ones included. Known gap: a check-then-use race (TOCTOU) |
| **`bash` processes** | Nothing a command starts outlives the call or the harness: the whole process group is killed on timeout, abort, leftover background processes and exit. The model's `timeout` is capped. Known gap: a command can leave its group on purpose (`setsid`); only a sandbox stops that (Day 11) |
| **Tool arguments & tool output** | Untrusted data. They may contain prompt injection, and they never change what the harness permits |
| **Project config** (`.agent-harness/settings.json`) | Repo-controlled, so it may only **restrict**. It can never set `autoApprove`, provider URLs, `permissions.allow`, a permission mode looser than `read-only`, or `mcpServers`; it may only *lower* `contextWindow` (memory on your machine) and `maxTurns`; and choosing the model is announced (Day 26) |
| **Your terminal** | Text from tools, the model, file names, settings keys and servers is untrusted and may carry escape sequences. It is sanitized where it leaves the program (the `Printer`, `PromptUI.ask`, the CLI's stderr, and `-p`'s stdout when it's a terminal), not at each source (Day 27) |
| **Project extensions** (`.agent-harness/extensions/`) | Repo-controlled **code**. Load only after a trust prompt or `--allow-project-extensions`. The trust decision is stored in **your** config (`~/.config/agent-harness/trusted-projects.json`), never in the repo, and pinned to a hash of every file in the extensions tree — imported helpers included, so a later change re-asks (Day 22) |
| **`AGENTS.md` / `CLAUDE.md`** | **Project instructions**, followed for conventions (build commands, style). They rank below the system prompt and the user, and **cannot grant permissions**. The approval gate, permission rules and jail enforce policy. Prompt text doesn't (Day 24) |
| **MCP servers** | Starting one runs code, so they are configured in global settings only, and the server is spawned with a minimal environment (a safe baseline plus its configured `env`), never your whole `process.env`. Every MCP tool `needsApproval` by default, and their descriptions are untrusted (Day 23) |
| **The lethal trifecta** | Private data + untrusted content + a way to send data out = exfiltration risk. Day 27 attacks your harness through exactly this |

Wrapping untrusted text in "this is data" markers helps a little, but it is **not** a defence. Models can still follow injected instructions. Capability limits (approval, permissions, the jail, no network) are the defence.

### Storage and settings

- **Global:** `path.join(os.homedir(), '.config', 'agent-harness', …)` on every OS, never a literal `~/` string. It holds `settings.json`, `sessions/`, `logs/`, `extensions/`, `skills/` and `trusted-projects.json`.
- **Sessions** are private (folders `0o700`, files `0o600`), because they hold everything the tools printed. Each one records the folder it was started in, and resume only offers sessions from the current folder (Day 19).
- **Project:** `.agent-harness/settings.json`, `.agent-harness/extensions/` and `.agent-harness/skills/` (all repo-controlled, see above).
- **Precedence:** defaults ← global ← project (restrict-only) ← CLI flags. Last wins.
- **The settings shape (Day 26):**
  - `provider`, `ollamaUrl`, `openai.baseUrl`, `defaultModel`
  - `contextWindow` (sent as `num_ctx`), `think`
  - `maxTurns`, `streaming`, `autoApprove`, `systemPrompt`
  - `tools.enabled`, `permissions.{mode,allow,deny}`
  - `compaction.{enabled,contextLimit,keepMessages}`, `mcpServers`

### CLI flags (Day 26)

| Flag | Meaning |
|---|---|
| `-p/--print` | One-shot answer to stdout |
| `-c/--continue` | Continue this folder's last session |
| `--resume` | Pick one of this folder's sessions to resume |
| `--new` | Start a fresh session |
| `--model` | Model to use |
| `--provider` | Provider to use |
| `--system-prompt` | Extra system prompt text |
| `--extension` | Load an extension file (repeatable) |
| `--allow-project-extensions` | Load project extensions without the trust prompt |
| `--permission-mode` | `default`, `read-only`, `accept-edits` or `yolo` |
| `--auto-approve` | Same as `--permission-mode yolo` |
| `--no-tools` / `--tools a,b` | Disable tools / enable only these |
| `--verbose` (or `-V`) | Debug logging |
| `--script <file>` | Script for `--provider scripted` (tests, evals, the offline demo) |
| `-h/--help` | Usage |
| `-v/--version` | Version |

**`-v` is `--version`, never verbose.**

**Exit codes:** 0 ok · 1 runtime error · 2 usage or settings error · 3 no final answer (`maxTurns` ran out) · 4 answered, but tool calls were denied (nobody could approve them, or a rule or mode refused them) · 130 interrupted.

## Glossary

| Term | Meaning |
|---|---|
| **Agent harness** | The program between a user and an LLM. It runs the loop, executes tools *in your process*, manages history, enforces safety and renders the UI |
| **Turn** | One LLM response plus the tool calls/results that follow before the next LLM call |
| **Tool call / result** | The model's structured request to run a tool / the observation fed back (errors included) |
| **Tool pair** | An assistant tool-call message plus all of its tool results |
| **Provider** | Adapter between harness shapes and one LLM API's wire format |
| **Thinking** | Reasoning text a model emits before its answer (`message.thinking` in Ollama). Kept in history, shown dimmed, never treated as the answer |
| **`num_ctx`** | The context window Ollama allocates for a request. Default 4096 on most laptops. Send it explicitly |
| **Context window** | Max tokens per call: system prompt + tools + history + reply |
| **Prompt caching** | Servers reuse work for an unchanged prompt *prefix*. Ollama re-ran a 302-token prompt in 54 ms instead of 631 ms. Keep the prefix stable (Day 24) |
| **Session entry / active path** | One persisted record / the root→leaf chain the model actually sees (`getPath()`) |
| **Compaction** | Folding old active-path entries into one record so history fits the window, keeping tool pairs and the latest user message |
| **Approval gate / permission mode / rule** | y/N/a confirmation for risky tools / a preset policy / an allow or deny pattern like `bash(git status)` |
| **MCP** | Model Context Protocol: a standard JSON-RPC protocol for exposing tools to any harness. Revision `2026-07-28` is stateless |
| **Agent Skill** | A folder with a `SKILL.md` (name, description, instructions). The harness lists skills cheaply and loads one only when needed (progressive disclosure) |
| **AGENTS.md** | Project instructions for coding agents (build commands, conventions). Followed, but cannot grant permissions |
| **Prompt injection** | Untrusted text (a file, a web page, tool output) that tries to instruct the model |
| **Eval / pass@k** | A scripted task with a pass/fail checker / the chance that at least one of *k* attempts passes. pass^k means *all* k pass |
| **NDJSON / SSE** | Newline-delimited JSON (Ollama's native stream) / Server-Sent Events, `data:` lines (OpenAI-style streams) |
| **Fixture** | A captured real response used by tests |

## Troubleshooting

| Symptom | Likely cause | What to try |
|---|---|---|
| `ECONNREFUSED` to `:11434` | Ollama not running | `ollama serve`, or start the app |
| Model not found | Not pulled | `ollama pull qwen3.5:4b` |
| Model "forgets" its instructions or tools in long chats, **no error** | Ollama's default 4k window silently truncated the prompt | Send `options.num_ctx` (Day 1+), check `ollama ps`, and budget with `getModelInfo().contextLimit` (Day 8) |
| No tool calls ever | Model without tool support, or tools not sent | `ollama show <model>` must list `tools`; check `tools` in your request body |
| `<think>` tags inside `content` | Server didn't split reasoning out | Send `think: true` explicitly; capture again (Day 7) |
| Tool calls missing when streaming | You read tool calls from the final `done` chunk | Ollama sends each call in an *earlier* chunk; collect them as they arrive (Day 16) |
| Infinite tool loop | No maxTurns, or tool errors thrown instead of returned | Enforce `maxTurns`; return errors as results |
| `node --test tests/course/` fails with `Cannot find module` | Node 22+ takes files or globs, not directories | `node --test`, or `node --test tests/course/*.test.js` |
| Ctrl+C at a `[y/N]` question waits for Enter | The question wasn't given the run's signal | `rl.question(prompt, { signal })` (Day 3) |
| HTTP 400 `"<model>" does not support thinking` | `think: true` sent to a model without the thinking capability | The provider drops `think` for that model and retries (Day 8); so does the toy (Day 4) |
| `fetch failed` after exactly 5 minutes (`UND_ERR_HEADERS_TIMEOUT`) | A non-streaming reply that took over 300 s: Ollama's output limit is unlimited by default, so a runaway model never stops | The provider sends `num_predict` (default: the window) and names the timeout (Day 8); stream long answers |
| HTTP 500 `token repeat limit reached` / `error parsing tool call` | The model's output went wrong (a repetition loop, a malformed tool call), mostly with tiny models | Ask again or rephrase; use a bigger model (Day 8) |
| A tool call fails with `unexpected property '…'` | The model invented an argument the tool doesn't have | Working as intended: the model is told the allowed names and retries (Day 9) |
| A server or watcher the agent started (`npm run dev &`) is gone | By design: nothing a command starts outlives it (Day 11) | Run long-lived processes yourself, outside the agent |
| `the model saw only ~N of ~M prompt tokens` | The server cut the prompt to fit its window (silently, HTTP 200): a huge paste, a `/v1` server with a smaller window than you set, or too little room left | Send less, raise `contextWindow` (or the server's own, e.g. `OLLAMA_CONTEXT_LENGTH`), or `/compact` (Day 24) |
| `-p` exits **4** | It answered, but tool calls were denied (the warning says whether nobody could approve them or a rule or mode refused them); the answer can't reflect them | Opt in with `--auto-approve` or an allow rule, if you mean it, or change the rule or mode. For a text-only prompt, pass `--no-tools`: small models often reach for a tool they don't need (Day 26) |
| 400s from a hosted API after compaction | A tool pair was split | Day 25 invariant |
| Garbled terminal after a crash | readline not closed on an error path | One `shutdown()` path (Day 26) |
| Unexpected code ran at startup | Project extension auto-loaded | Trust prompt (Day 22) |
| A cloned repo made the agent stop asking before running commands | Project settings were allowed to loosen permissions | Restrict-only project layer (Day 26) |

## Pi's architecture

Pi is the open-source coding agent you read on Day 6 and compare yours with on Day 30. Clone it once, at the version this course was checked against, into a `reference/` folder beside your project (the folder that also holds `agent-harness-curriculum`):

```bash
git clone --depth 1 --branch v0.80.3 https://github.com/earendil-works/pi.git reference/pi
```

The clone is about 23 MB. Treat it as read-only: study it, and never import it. Pi has kept moving since 0.80.3, and later versions add and remove whole packages (1.3.0 drops `orchestrator` and adds a package called `mcp`, for example), so clone the tag rather than the latest code. Every Pi path this course names is checked against it.

- **`packages/agent`** (`@earendil-works/pi-agent-core`) is the agent loop. It has an `AgentEvent` union in `src/types.ts`, the loop in `src/agent-loop.ts`, and session storage in `src/harness/session/`. This is the closest analogue to our [canonical events](#canonical-event-list).
- **`packages/coding-agent`** (`@earendil-works/pi-coding-agent`) is the product: tools in `src/core/tools/`, `src/core/session-manager.ts` and `src/cli/args.ts`. A separate hook union in `packages/agent/src/harness/types.ts` includes `tool_call` and `tool_result`. Do not mix it up with `AgentEvent`.
- **`packages/tui`** (`@earendil-works/pi-tui`) is a terminal UI library with differential rendering, and a good post-course study target.
- **`packages/ai`** and **`packages/orchestrator`** also exist. Neither is the agent loop; skip them for this course.

**Vocabulary differences:** Pi's `AgentEvent` has `turn_start` / `turn_end`, streams through `message_update`, and splits tool execution into `tool_execution_start` / `_update` / `_end`. Ours uses `text_delta` / `thinking_delta`, `tool_call_start` / `tool_call_end` / `tool_result`, and adds approval and compaction events. When reading Pi, translate mentally. When writing extensions for *your* harness, use ours.

**Design differences worth knowing:** Pi 0.80.3 deliberately ships without MCP support, sub-agents or a plan mode (see Mario's post). This course adds MCP on Day 23 because it is now the standard way to plug tools into harnesses. Both choices are defensible, and arguing them is part of Day 30.

---
[Curriculum home](README.md)
