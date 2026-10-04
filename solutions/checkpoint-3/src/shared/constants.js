// src/shared/constants.js — the course-wide defaults, defined once.
// Change the model here (and in your settings file) — nowhere else.

/** The course model. Verified 2026-10-01 on Ollama 0.32.0: tool calls, parallel calls, thinking, streaming. */
export const DEFAULT_MODEL = 'qwen3.5:4b';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * The context window we ASK Ollama for (sent as `options.num_ctx` on every request).
 * Ollama's own default is only 4096 tokens on machines with < 24 GiB VRAM, and it silently
 * drops the start of the prompt when you overflow it. Never rely on the server default.
 */
export const DEFAULT_CONTEXT_WINDOW = 8192;

/** Tool output truncation cap (UTF-8 bytes). */
export const TRUNCATE_MAX_BYTES = 32 * 1024;

/** `@file` attachment cap (UTF-8 bytes). */
export const FILE_REF_MAX_BYTES = 50 * 1024;

export const DEFAULT_MAX_TURNS = 20;
