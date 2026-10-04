#!/usr/bin/env node
// src/cli/main.js — interactive entry point (Day 15; resume 19; provider 21; MCP 23). Day 26 adds flags + settings.
import fs from 'node:fs';
import { createApp } from '../app.js';
import { createProvider } from '../provider/index.js';

// Temporary switches until Day 26's settings file takes over:
//   AH_PROVIDER=openai-compatible   AH_STREAM=0   AH_MCP_CONFIG=path/to/mcp.json  ({ "notes": { "command": "node", "args": ["examples/mcp/notes-server.mjs"] } })
const provider = createProvider({ provider: process.env.AH_PROVIDER ?? 'ollama' });
const mcpServers = process.env.AH_MCP_CONFIG ? JSON.parse(fs.readFileSync(process.env.AH_MCP_CONFIG, 'utf8')) : {};
const app = createApp({ provider, streaming: process.env.AH_STREAM !== '0', mcpServers });
await app.start({ resume: 'ask' });
