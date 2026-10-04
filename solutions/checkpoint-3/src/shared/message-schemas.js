// src/shared/message-schemas.js — the harness's ONE internal vocabulary (Day 7).
// Typedefs only. Every provider translates its wire format to and from these shapes;
// nothing above src/provider/ ever sees a provider's field names.

/**
 * @typedef {'system'|'user'|'assistant'|'tool_result'} Role
 */

/**
 * A tool call requested by the model.
 * `id`: the server's id when it sends one (Ollama 0.32 does: "call_…"), otherwise generated
 *       by the provider at the boundary. Never empty.
 * `arguments`: ALWAYS a plain object inside the harness. Providers parse strings at the boundary.
 * `parseError`: set by the provider when the wire arguments were not valid JSON; the loop turns
 *       it into an isError tool result asking the model to retry (Day 9's malformed-args policy).
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown>} arguments
 * @property {string} [parseError]
 */

/**
 * @typedef {object} Usage
 * @property {number} [promptTokens]      tokens the server processed for the prompt
 * @property {number} [completionTokens]  tokens generated
 */

/**
 * One message in the harness's history.
 * - `thinking`: reasoning text from a thinking model (assistant only). Kept in history and
 *   sent back to the server with tool results, but never shown as the answer.
 * - `toolCalls`: assistant messages that requested tools.
 * - `toolCallId` / `toolName` / `isError`: tool_result messages.
 * @typedef {object} AgentMessage
 * @property {Role} role
 * @property {string} content
 * @property {string} [thinking]
 * @property {ToolCall[]} [toolCalls]
 * @property {string} [toolCallId]
 * @property {string} [toolName]
 * @property {boolean} [isError]
 * @property {Usage} [usage]
 */

/**
 * What the model may call, as the PROVIDER sees it (no `execute`, no policy fields).
 * @typedef {object} ToolSpec
 * @property {string} name
 * @property {string} description
 * @property {object} parameters   JSON Schema for the arguments object
 */

/**
 * finishReason: 'stop' | 'length' | 'tool_calls' | 'aborted' | string (server-specific values pass through)
 * @typedef {object} ChatResponse
 * @property {string} content
 * @property {string} [thinking]
 * @property {ToolCall[]} toolCalls
 * @property {Usage} [usage]
 * @property {string} model
 * @property {string} [finishReason]
 */

/**
 * What chatStream() yields. Exactly these five shapes.
 * Ollama sends each tool call whole, so it produces tool_call_start + one tool_call_delta
 * holding the full arguments JSON. OpenAI-style servers may split arguments across many deltas.
 * `done.response` is the fully assembled ChatResponse — identical to what chat() would return.
 * @typedef {{ type: 'text_delta', content: string }
 *   | { type: 'thinking_delta', content: string }
 *   | { type: 'tool_call_start', id: string, name: string }
 *   | { type: 'tool_call_delta', id: string, argsDelta: string }
 *   | { type: 'done', response: ChatResponse }} StreamEvent
 */

/**
 * @typedef {object} ModelInfo
 * @property {string} name
 * @property {number} contextLimit   the window we will actually get: min(requested num_ctx, model maximum)
 * @property {number|null} maxContext the model's trained maximum from /api/show (null if unknown)
 * @property {string[]} capabilities e.g. ['completion','tools','thinking']
 */

/**
 * The provider interface. Every provider (Ollama, OpenAI-compatible, Scripted) implements it.
 * @typedef {object} Provider
 * @property {string} model
 * @property {(messages: AgentMessage[], tools: ToolSpec[], opts?: { signal?: AbortSignal }) => Promise<ChatResponse>} chat
 * @property {(messages: AgentMessage[], tools: ToolSpec[], opts?: { signal?: AbortSignal }) => AsyncGenerator<StreamEvent>} chatStream
 * @property {() => Promise<{ name: string, capabilities?: string[] }[]>} [listModels]   arrives on Day 18 (/model)
 * @property {(name?: string) => Promise<ModelInfo>} getModelInfo
 * @property {(name: string) => void} setModel
 */

export {};
