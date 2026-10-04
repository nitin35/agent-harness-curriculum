// src/provider/index.js — pick a provider by name (Day 21; 'scripted' + settings on Day 26).
import fs from 'node:fs';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { ScriptedProvider } from './scripted.js';

/**
 * @param {{
 *   provider?: string,              // 'ollama', 'openai-compatible' or 'scripted' (it comes from settings or a flag: checked below)
 *   model?: string, contextWindow?: number, think?: boolean | 'low' | 'medium' | 'high',
 *   ollamaUrl?: string,
 *   openai?: { baseUrl?: string, apiKeyEnv?: string },
 *   scriptFile?: string,             // 'scripted': a JSON array of ChatResponses (tests, evals, the offline demo)
 *   env?: Record<string, string|undefined>,
 * }} opts
 */
export function createProvider({ provider = 'ollama', model, contextWindow, think, ollamaUrl, openai = {}, scriptFile, env = process.env } = {}) {
  if (provider === 'ollama') return new OllamaProvider({ baseUrl: ollamaUrl, model, contextWindow, think });
  if (provider === 'openai-compatible') {
    // The key comes from an environment variable NAMED in settings — never stored in a settings file.
    const apiKey = openai.apiKeyEnv ? env[openai.apiKeyEnv] : undefined;
    return new OpenAICompatibleProvider({ baseUrl: openai.baseUrl, apiKey, model, contextWindow });
  }
  if (provider === 'scripted') {
    if (!scriptFile) throw new TypeError("provider 'scripted' needs a script file (--script path/to/script.json)");
    const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
    return new ScriptedProvider(script, { model: 'scripted', contextLimit: contextWindow ?? 8192 });
  }
  throw new TypeError(`unknown provider '${provider}' (use 'ollama', 'openai-compatible' or 'scripted')`);
}
