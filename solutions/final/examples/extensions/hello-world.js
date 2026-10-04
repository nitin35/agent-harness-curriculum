// examples/extensions/hello-world.js — the smallest useful extension (Day 22).
// Install: copy into ~/.config/agent-harness/extensions/ (or pass --extension examples/extensions/hello-world.js).
export const meta = { name: 'hello-world', description: 'A greet tool, a /greet command, and a startup hello' };

/** @param {import('../../src/shared/extension.js').ExtensionAPI} api */
export default function (api) {
  api.registerTool({
    name: 'greet',
    description: 'Greet someone by name. Use when the user asks you to greet or say hello to a person.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Who to greet' } }, required: ['name'] },
    readOnly: true, // changes nothing, so it never needs approval
    async execute({ name }) {
      return { content: `Hello, ${name}! 👋 (from the hello-world extension)`, isError: false };
    },
  });

  api.registerCommand({
    name: 'greet',
    usage: '/greet [name]',
    description: 'Say hello (hello-world extension)',
    handler: ([name = 'world']) => `Hello, ${name}!`,
  });

  api.on('session_start', ({ sessionId }) => api.ui.notify(`loaded (session ${sessionId.slice(0, 8)})`));
}
