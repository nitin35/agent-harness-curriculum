// src/index.js — the public library API (Day 26). Importing this file starts nothing and touches no network.
export { AgentLoop } from './agent/agent-loop.js';
export { PermissionPolicy } from './agent/permissions.js';
export { createApprovalGate } from './agent/approval-gate.js';
export { OllamaProvider } from './provider/ollama.js';
export { OpenAICompatibleProvider } from './provider/openai-compatible.js';
export { ScriptedProvider } from './provider/scripted.js';
export { createProvider } from './provider/index.js';
export { ToolRegistry } from './tools/tool-registry.js';
export { createBuiltinTools } from './tools/builtin/index.js';
export { SessionManager } from './session/session-manager.js';
export { EventBus } from './events/event-bus.js';
export { McpClient } from './mcp/mcp-client.js';
export { createApp } from './app.js';
export { loadSettings, DEFAULT_SETTINGS } from './config/settings.js';
export * as events from './shared/events.js';
