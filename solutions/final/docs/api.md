# Library API (`import … from 'agent-harness'`)

Importing `src/index.js` starts nothing and touches no network.

| Export | What it is |
|---|---|
| `AgentLoop` | the engine: `new AgentLoop({ provider, registry, approve?, emit?, streaming?, … }).run(text, history, { signal })` → `AgentResult` |
| `PermissionPolicy` | rules and modes: `decide(call, tool)` → `allow` / `deny` / `ask` |
| `createApprovalGate` | `{ approve }` for `AgentLoop`, request/response over an `EventBus` |
| `OllamaProvider` | Ollama `/api/chat` (sends `num_ctx`, handles thinking, streaming, tool calls) |
| `OpenAICompatibleProvider` | `/v1/chat/completions` servers (SSE, fragmented tool calls) |
| `ScriptedProvider` | deterministic provider for tests, evals and demos |
| `createProvider` | pick a provider by name from settings |
| `ToolRegistry` | `registerTool` / `getTool` / `getTools` / `unregisterTool` / `toProviderTools` |
| `createBuiltinTools` | `read`, `write`, `edit`, `bash` for one workspace root |
| `SessionManager` | append-only JSONL session tree: `create`, `open`, `appendMessage`, `getMessages`, `compact`, `branch` |
| `EventBus` | strict, failure-isolated, canonical-name event bus |
| `McpClient` | stdio MCP client (modern 2026-07-28 + legacy fallback) |
| `createApp` | everything wired together (what the CLI uses); `start()` interactive, `runOnce()` headless |
| `loadSettings` | layered settings with the restrict-only project layer |
| `DEFAULT_SETTINGS` | the frozen defaults |
| `events` | `EVENTS`, `ALL_EVENTS`, `isCanonicalEvent` |
