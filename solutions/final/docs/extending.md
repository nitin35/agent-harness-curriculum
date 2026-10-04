# Extending agent-harness

## Extensions

An extension is an ES module with a default-export factory:

```js
export const meta = { name: 'hello-world' };
export default function (api) {
  api.registerTool({ name: 'greet', description: '…', parameters: { type: 'object', … }, readOnly: true, execute: async ({ name }) => `Hello, ${name}!` });
  api.registerCommand({ name: 'greet', description: '…', handler: ([n = 'world']) => `Hello, ${n}!` });
  api.on('session_start', ({ sessionId }) => api.ui.notify('loaded'));
}
```

| API | Notes |
|---|---|
| `api.on(event, handler)` | canonical event names only. An unknown name throws at load |
| `api.registerTool(def)` | `needsApproval: true` for anything risky (the approval gate handles it), `readOnly: true` for harmless tools |
| `api.registerCommand(def)` | `/name` in the prompt |
| `api.sendMessage(text, { as: 'queue' \| 'note' })` | `queue` becomes a user turn (queued if busy); `note` is saved without running the model |
| `api.ui.notify(text)` / `api.ui.confirm(question)` | `confirm` is for your extension's UX, **never** for tool approval |
| `api.cwd`, `api.name` | |

Everything an extension registers is removed when it unloads.

## Trust model

Extensions run **in-process with your privileges**. There is no sandbox. Where they come from:
- `~/.config/agent-harness/extensions/` and `--extension <file>` load, because you put them there;
- `<repo>/.agent-harness/extensions/` loads only after you answer **y** to the trust prompt (or pass `--allow-project-extensions`). The decision is stored in `~/.config/agent-harness/trusted-projects.json`, pinned to a hash of **every file in the extensions folder** (helpers included), so a changed or added file anywhere in it asks again. Code an extension imports from *outside* that folder isn't covered: keep extensions self-contained.

## Canonical events

| Event | Payload |
|---|---|
| `session_start` / `session_shutdown` | `{ sessionId }` |
| `agent_start` | `{ userMessage }` |
| `turn_start` / `turn_end` | `{ turn }` / `{ turn, usage? }` |
| `thinking_delta` / `text_delta` | `{ content }` |
| `tool_call_start` | `{ id, name, arguments }` |
| `tool_approval_request` / `tool_approval_result` | `{ id, name, arguments }` / `{ id, approved, remember? }` |
| `tool_call_end` | `{ id, name }` |
| `tool_result` | `{ id, name, content, isError }` |
| `agent_end` | `{ response, turns, aborted }` |
| `compaction` | `{ dropped, kept }` |
| `error` | `{ message, cause? }` |
| `command_run` | `{ name, args }` |
| UI → bus: `user_message` · `abort` · `command` | `{ content }` · `{}` · `{ line }` |

There are no aliases. (Pi's `tool_call` hook and `message_update` event have no equivalent name here.)

## Skills

`~/.config/agent-harness/skills/<name>/SKILL.md`, with frontmatter `name` (lowercase-hyphenated, matching the folder) and `description`. Only `name: description` goes into the system prompt; the model calls `load_skill` for the rest. Project skills (`<repo>/.agent-harness/skills/`) are repo-controlled instructions: followed, but they cannot grant permissions.

## MCP servers

Add them to your **global** settings: `"mcpServers": { "notes": { "command": "node", "args": ["path/to/server.mjs"] } }`. Their tools appear as `mcp__<server>__<tool>` and always need approval. A server starts with a minimal environment (`PATH`, `HOME`, …), not yours: give it the secrets it needs through its own `env` (`"env": { "API_TOKEN": "…" }`). If two of its tools collide after their names are cleaned up, the second is skipped with a warning.
