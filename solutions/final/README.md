# agent-harness

A terminal coding agent, built from scratch in 30 days. It's a JavaScript harness (Node 22+, no dependencies) around local models (Ollama) or any OpenAI-compatible server.

```
$ agent-harness
> @src/greet.js add a farewell() next to greet()
  · attached: src/greet.js (162 B)
  ⚙ edit {"path":"src/greet.js", …}
  allow edit …? [y]es / [N]o / [a]lways this session y
agent> Added farewell(name) below greet().
```

## Install

```bash
ollama pull qwen3.5:4b        # or qwen3.5:9b with 16 GB+ RAM
npm link                      # puts `agent-harness` on your PATH
agent-harness --help
```

## Use

| Command | What it does |
|---|---|
| `agent-harness` | interactive; offers to resume this folder's last session |
| `agent-harness -c` / `--resume` / `--new` | continue this folder's last session / pick one of its sessions / start fresh |
| `agent-harness -p "question"` | one answer on stdout. **Tools that need approval are denied** unless you pass `--auto-approve` or have an allow rule; if any were, stderr says so and the exit code is 4. For a text-only prompt, pass `--no-tools` |
| `agent-harness --permission-mode read-only` | explore an untrusted repo safely |

**Input:**
- `@path` attaches a file (jailed to the workspace; at most 50 KiB per file, and all attachments together cut to fit ~40% of the context window).
- Tab completes `/commands` and `@paths`.
- A line containing only `<<<` starts and ends a multi-line message. Shift+Enter is **not** supported, and pasting several lines sends them separately.
- Ctrl+C aborts the current run (and drops queued messages); press it twice to exit.

**Exit codes (`-p`):** 0 ok · 1 runtime error · 2 usage or settings error · 3 no final answer (`maxTurns`) · 4 answered, but tool calls were denied · 130 interrupted.

**Commands:** `/help` `/session` `/new` `/resume` `/model [name]` `/permissions` `/context` `/compact` `/mcp` `/quit`

## Settings

`~/.config/agent-harness/settings.json` (yours). A repository's `.agent-harness/settings.json` may only **tighten** (deny rules, `read-only`, fewer tools, a smaller window, fewer turns) and set harmless preferences (choosing the model is announced). Everything else is ignored with a warning.

| Key | Default | |
|---|---|---|
| `provider` | `"ollama"` | `ollama` · `openai-compatible` · `scripted` |
| `defaultModel` | `"qwen3.5:4b"` | |
| `contextWindow` | `8192` | sent as `num_ctx`; Ollama's own default is only 4096. A project file may only lower it |
| `maxTurns` | `20` | model calls per run; a project file may only lower it |
| `think` | `true` | |
| `permissions` | `{ mode: "default", allow: [], deny: [] }` | rules like `bash(git status)`, `bash(npm test*)`, `write(src/*)`. A wildcard `bash` allow never matches a chained command; paths are matched normalized |
| `compaction` | `{ enabled: true, contextLimit: null, keepMessages: 6 }` | `contextLimit` can only lower the window |
| `mcpServers` | `{}` | `{ "notes": { "command": "node", "args": ["server.mjs"] } }` (global file only) |
| `openai` | `{ baseUrl, apiKeyEnv: "OPENAI_API_KEY" }` | the key itself stays in the environment variable |

There is no `theme` and no `maxTokens`. Unknown keys are ignored with a warning.

## Extend

- **Extensions:** `~/.config/agent-harness/extensions/*.js` (see [docs/extending.md](docs/extending.md)).
- **Skills:** `~/.config/agent-harness/skills/<name>/SKILL.md`.
- **Project instructions:** `AGENTS.md`.
- **MCP servers:** add them to `mcpServers` in your global settings.

## Dependencies

| Package | Version | Why | Alternative rejected |
|---|---|---|---|
| *(none)* | — | Node built-ins cover HTTP, streams, child processes, tests | Ajv, an MCP SDK and a TUI library were all deliberately left out (see `docs/architecture.md`) |

## Develop

`node --test` runs the unit, integration and course tests. `node examples/demo.js` gives an offline demo. `node examples/evals/run.js [--live --trials 5]` runs the evals.
