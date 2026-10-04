// src/agent/agent-loop.js — the engine (Day 12; abort Day 13; events Day 14; streaming Day 16).
import { DEFAULT_MAX_TURNS } from '../shared/constants.js';
import { isAbortError } from '../shared/errors.js';
import { validateArguments, validateToolResult } from '../shared/tool-schemas.js';
import { validateAgentOptions } from './agent-schemas.js';

/** @typedef {import('../shared/message-schemas.js').AgentMessage} AgentMessage */
/** @typedef {import('../shared/message-schemas.js').ToolCall} ToolCall */
/** @typedef {import('../shared/tool-schemas.js').ToolResult} ToolResult */

export const DEFAULT_SYSTEM_PROMPT =
  'You are a coding assistant running in a terminal, inside the user\'s workspace. ' +
  'You have tools to read, write and edit files and to run shell commands. Use them to answer from ' +
  'facts instead of guessing. If a tool returns an error, read it and adjust.';

export class AgentLoop {
  #running = false;

  /** @param {import('./agent-schemas.js').AgentOptions} options */
  constructor(options) {
    const check = validateAgentOptions(options);
    if (!check.ok) throw new TypeError(`invalid AgentLoop options: ${check.error}`);
    this.provider = options.provider;
    this.registry = options.registry;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.approve = options.approve;
    this.autoApprove = options.autoApprove ?? false;
    this.enabledTools = options.enabledTools;
    this.emit = options.emit ?? (() => {});
    this.streaming = options.streaming ?? false;
  }

  get isRunning() { return this.#running; }

  /**
   * Run one user message to completion.
   * @param {string} userMessage
   * @param {AgentMessage[]} [history]  the conversation so far (Day 19: session.getMessages())
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<import('./agent-schemas.js').AgentResult>}
   */
  async run(userMessage, history = [], { signal } = {}) {
    if (this.#running) throw new Error('AgentLoop.run() is already running — queue the message instead');
    this.#running = true;

    /** @type {AgentMessage[]} */
    const newMessages = [{ role: 'user', content: userMessage }];
    const toolLog = [];
    const usage = { promptTokens: 0, completionTokens: 0, lastPromptTokens: undefined };
    let response = '';
    let turn = 0;
    const result = (extra) => ({ response, turns: turn, toolCalls: toolLog, usage, aborted: false, newMessages, ...extra });

    this.emit('agent_start', { userMessage });
    try {
      for (turn = 1; turn <= this.maxTurns; turn++) {
        if (signal?.aborted) return result({ aborted: true });
        this.emit('turn_start', { turn });

        const system = typeof this.systemPrompt === 'function' ? await this.systemPrompt() : this.systemPrompt;
        const messages = [{ role: 'system', content: system }, ...history, ...newMessages];
        const tools = this.registry.toProviderTools(this.enabledTools); // fresh EVERY call (Day 22 adds tools at runtime)

        let reply;
        try {
          reply = await this.#callModel(messages, tools, signal);
        } catch (err) {
          if (isAbortError(err) || signal?.aborted) return result({ aborted: true });
          throw err;
        }
        if (reply.usage) {
          usage.promptTokens += reply.usage.promptTokens ?? 0;
          usage.completionTokens += reply.usage.completionTokens ?? 0;
          usage.lastPromptTokens = reply.usage.promptTokens;
        }

        /** @type {AgentMessage} */
        const assistant = { role: 'assistant', content: reply.content };
        if (reply.thinking) assistant.thinking = reply.thinking;
        if (reply.toolCalls.length) assistant.toolCalls = reply.toolCalls;
        if (reply.usage) assistant.usage = reply.usage;
        newMessages.push(assistant);
        response = reply.content;

        if (!reply.toolCalls.length) {
          this.emit('turn_end', { turn, usage: reply.usage });
          return result();
        }

        // Tool-pair invariant: the assistant message is followed by a result for EVERY call,
        // in order, before the model is called again — even when we abort halfway.
        for (const call of reply.toolCalls) {
          /** @type {ToolResult} */
          let toolResult;
          if (signal?.aborted) {
            toolResult = { content: 'Skipped: run aborted', isError: true };
          } else {
            this.emit('tool_call_start', { id: call.id, name: call.name, arguments: call.arguments });
            toolResult = await this.executeTool(call, { signal });
            this.emit('tool_call_end', { id: call.id, name: call.name });
          }
          this.emit('tool_result', { id: call.id, name: call.name, content: toolResult.content, isError: toolResult.isError });
          toolLog.push({ id: call.id, name: call.name, isError: toolResult.isError });
          newMessages.push({ role: 'tool_result', content: toolResult.content, toolCallId: call.id, toolName: call.name, isError: toolResult.isError });
        }
        this.emit('turn_end', { turn, usage: reply.usage });
        if (signal?.aborted) return result({ aborted: true });
      }
      turn = this.maxTurns;
      return result({ warning: `stopped after maxTurns (${this.maxTurns}) without a final answer` });
    } finally {
      this.#running = false;
      // agent_end fires on every exit path (answer, maxTurns, abort, error), exactly once
      this.emit('agent_end', { response, turns: Math.min(turn, this.maxTurns), aborted: Boolean(signal?.aborted) });
    }
  }

  /**
   * Look up, validate, approve, execute, normalize. Never throws: every failure is a ToolResult.
   * @param {ToolCall} call
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<ToolResult>}
   */
  async executeTool(call, { signal } = {}) {
    const tool = this.registry.getTool(call.name);
    const enabled = !this.enabledTools || this.enabledTools.includes(call.name);
    if (!tool || !enabled) {
      const names = this.registry.toProviderTools(this.enabledTools).map((t) => t.name).join(', ');
      return { content: `Unknown tool '${call.name}'. Available tools: ${names || '(none)'}.`, isError: true };
    }
    if (call.parseError) {
      return { content: `Invalid arguments for ${call.name}: ${call.parseError}. Retry the call with corrected arguments.`, isError: true };
    }
    const check = validateArguments(tool.parameters, call.arguments);
    if (!check.ok) {
      return { content: `Invalid arguments for ${call.name}: ${check.error}. Retry the call with corrected arguments.`, isError: true };
    }

    if (tool.needsApproval && !this.autoApprove) {
      const decision = await this.#askApproval(call, tool, signal);
      if (!decision.approved) {
        // Who refused decides the wording; route on the field, never on the reason's text (Day 5).
        const who = decision.by === 'policy' ? 'Denied' : 'User denied';
        return { content: `${who} ${call.name}${decision.reason ? ` (${decision.reason})` : ''}`, isError: true };
      }
    }

    try {
      const raw = await tool.execute(call.arguments, { signal });
      const normalized = typeof raw === 'string' ? { content: raw, isError: false } : raw;
      const valid = validateToolResult(normalized);
      if (!valid.ok) return { content: `Tool ${call.name} returned an invalid result: ${valid.error}`, isError: true };
      return normalized;
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return { content: `${call.name} aborted`, isError: true };
      return { content: `Tool ${call.name} failed: ${err?.message ?? err}`, isError: true };
    }
  }

  /**
   * Fail closed: no approver attached means deny.
   * → { approved, reason?, by? }. `by: 'policy'` marks a refusal no human made (a rule, a mode, no approver);
   *   anything else (a "no", a timeout, Ctrl+C) counts as the user's.
   */
  async #askApproval(call, tool, signal) {
    if (!this.approve) {
      return { approved: false, by: 'policy', reason: 'approval required but no approver is attached; run interactively, add an allow rule, or pass --auto-approve' };
    }
    if (signal?.aborted) return { approved: false, reason: 'run aborted' };
    try {
      const answer = await this.approve(call, tool, { signal });
      return typeof answer === 'boolean' ? { approved: answer } : { approved: Boolean(answer?.approved), reason: answer?.reason, by: answer?.by };
    } catch (err) {
      if (isAbortError(err)) return { approved: false, reason: 'run aborted' }; // Ctrl+C at the question
      return { approved: false, by: 'policy', reason: `approval failed: ${err?.message ?? err}` };
    }
  }

  /** Non-streaming for now; Day 16 adds the streaming path with identical results. */
  async #callModel(messages, tools, signal) {
    return this.provider.chat(messages, tools, { signal });
  }
}
