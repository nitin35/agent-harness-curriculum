// src/shared/commands.js — slash-command shapes (Day 18).

/**
 * @typedef {object} CommandDefinition
 * @property {string} name            without the slash: 'help'
 * @property {string} description     one line for /help
 * @property {string} [usage]         e.g. '/model [name]'
 * @property {string[]} [aliases]     e.g. ['h'] (each one a valid name, so it can be typed)
 * @property {boolean} [idle]         only between runs (/new, /resume): it swaps or rewrites the session
 * @property {(args: string[], ctx: CommandContext) => Promise<string|void> | string | void} handler
 *           returns text to print (or prints through ctx.ui itself)
 */

/**
 * Everything a command may touch — and nothing more. createApp() builds it.
 * @typedef {object} CommandContext
 * @property {import('../ui/prompt-ui.js').PromptUI} ui
 * @property {import('./message-schemas.js').Provider} provider
 * @property {import('../events/event-bus.js').EventBus} bus
 * @property {import('../commands/registry.js').CommandRegistry} commands
 * @property {string} cwd
 * @property {() => import('../session/session-manager.js').SessionManager} getSession
 * @property {() => boolean} [isBusy]   is a run in flight? (`idle` commands refuse while it is)
 * @property {() => Promise<import('../session/session-manager.js').SessionManager>} newSession       Day 19
 * @property {(path: string) => Promise<import('../session/session-manager.js').SessionManager>} openSession   Day 19
 * @property {() => Promise<Array<{ id: string, path: string, model: string, updatedAt: string, name?: string }>>} listSessions   Day 19: saved in THIS folder
 * @property {(name: string) => void | Promise<void>} [persistModel]   Day 26: write defaultModel to settings
 * @property {import('../agent/agent-loop.js').AgentLoop} [loop]
 * @property {import('../agent/permissions.js').PermissionPolicy} [policy]   Day 20
 * @property {Map<string, any>} [mcp]                     Day 23: connected servers
 * @property {() => Promise<object>} [contextStatus]       Day 24: the /context budget
 * @property {(code?: number) => void} quit
 */

export {};
