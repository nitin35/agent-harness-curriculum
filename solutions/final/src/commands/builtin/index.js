// src/commands/builtin/index.js — the built-in slash commands (Day 18; /resume Day 19; /permissions Day 20; /compact Day 25).

/** @typedef {import('../../shared/commands.js').CommandDefinition} CommandDefinition */

/** @returns {CommandDefinition[]} */
export function createBuiltinCommands() {
  return [
    {
      name: 'help',
      aliases: ['h'],
      description: 'List commands',
      handler: (args, ctx) => ctx.commands.list()
        .map((c) => `/${c.usage ? c.usage.replace(/^\//, '') : c.name}${c.aliases?.length ? ` (${c.aliases.map((a) => `/${a}`).join(', ')})` : ''} — ${c.description}`)
        .join('\n'),
    },
    {
      name: 'session',
      description: 'Show the current session',
      handler: (args, ctx) => {
        const s = ctx.getSession();
        return [`id ${s.id}`, `entries ${s.getEntries().length} (active path ${s.getPath().length})`, `model ${ctx.provider.model}`, `cwd ${ctx.cwd}`, `file ${s.path}`].join('\n');
      },
    },
    {
      name: 'new',
      description: 'Start a fresh session (the current one is already saved)',
      idle: true,
      handler: async (args, ctx) => {
        const s = await ctx.newSession();
        return `new session ${s.id.slice(0, 8)}`;
      },
    },
    {
      name: 'model',
      usage: '/model [name]',
      description: 'List models, or switch to one',
      handler: async ([name], ctx) => {
        const models = await ctx.provider.listModels();
        if (!name) {
          return models.map((m, i) => `${m.name === ctx.provider.model ? '*' : ' '} ${i + 1}. ${m.name}`).join('\n') || '(no models — try `ollama pull qwen3.5:4b`)';
        }
        const wanted = /^\d+$/.test(name) ? models[Number(name) - 1]?.name : name;
        if (!wanted) return `No model number ${name}.`;
        // Refuse before changing anything: a typo would otherwise break every message (and, from Day 26, every launch).
        const chosen = models.find((m) => m.name === wanted || m.name === `${wanted}:latest`)?.name;
        if (!chosen) {
          return `${wanted} is not installed, so the model is still ${ctx.provider.model}. Pull it first (\`ollama pull ${wanted}\`), or pick one from /model.`;
        }
        ctx.provider.setModel(chosen);
        const session = ctx.getSession();
        session.setModel(chosen);
        if (session.getEntries().length) await session.save();
        await ctx.persistModel?.(chosen);
        let note = '';
        try {
          const info = await ctx.provider.getModelInfo(chosen);
          if (info.capabilities?.length && !info.capabilities.includes('tools')) {
            note = ' — warning: this model does not list "tools". It can\'t call them, and Ollama may refuse every request that sends them';
          }
        } catch { /* no details: switch without the check */ }
        return `model → ${chosen}${note}`;
      },
    },
    {
      name: 'quit',
      aliases: ['exit', 'q'],
      description: 'Leave (the session is already saved)',
      handler: (args, ctx) => { ctx.quit(0); },
    },
  ];
}
