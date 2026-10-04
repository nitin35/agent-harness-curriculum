// src/provider/index.js — pick a provider by name (Day 21; settings drive it from Day 26).
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

/**
 * @param {{
 *   provider?: string,              // 'ollama' or 'openai-compatible' (it comes from an env var or a file: checked below)
 *   model?: string, contextWindow?: number, think?: boolean,
 *   ollamaUrl?: string,
 *   openai?: { baseUrl?: string, apiKeyEnv?: string },
 *   env?: Record<string, string|undefined>,
 * }} opts
 */
export function createProvider({ provider = 'ollama', model, contextWindow, think, ollamaUrl, openai = {}, env = process.env } = {}) {
  if (provider === 'ollama') return new OllamaProvider({ baseUrl: ollamaUrl, model, contextWindow, think });
  if (provider === 'openai-compatible') {
    // The key comes from an environment variable NAMED in settings — never stored in a settings file.
    const apiKey = openai.apiKeyEnv ? env[openai.apiKeyEnv] : undefined;
    return new OpenAICompatibleProvider({ baseUrl: openai.baseUrl, apiKey, model, contextWindow });
  }
  throw new TypeError(`unknown provider '${provider}' (use 'ollama' or 'openai-compatible')`);
}
