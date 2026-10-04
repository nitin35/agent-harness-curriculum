// scripts/tool-description-experiment.js — Day 9: does a tool's description change what the model does?
// Run: node scripts/tool-description-experiment.js [trials=10]      (about 5 minutes on qwen3.5:4b)
//
// One tool, two descriptions (clear and vague), thinking on and off, and two prompts:
//   - a project question, where the tool SHOULD be called;
//   - a general question, where it should NOT be.
// Every cell is a count over several trials. One run of a model proves nothing; a count is a measurement.
import { OllamaProvider } from '../src/provider/ollama.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

const TRIALS = Number(process.argv[2] ?? 10);
const DESCRIPTIONS = {
  clear: "Look up a term in THIS project's glossary (docs/glossary.md). Only for terms specific to this project; never for general knowledge.",
  vague: 'Looks things up.',
};
const PROMPTS = {
  project: "What does 'tool pair' mean?",       // the glossary is the only place this is defined
  general: 'What is the capital of France?',    // general knowledge: no tool needed
};

function registryWith(description) {
  const registry = new ToolRegistry();
  registry.registerTool({
    name: 'lookup',
    description,
    parameters: { type: 'object', properties: { term: { type: 'string', description: 'The term to look up' } }, required: ['term'] },
    async execute({ term }) { return { content: `(glossary entry for ${term})`, isError: false }; },
  });
  return registry;
}

console.log(`${TRIALS} trials per cell · tool called / trials\n`);
console.log('thinking  description  project question  general question');
for (const think of [false, true]) {
  const provider = new OllamaProvider({ think });
  for (const [label, description] of Object.entries(DESCRIPTIONS)) {
    const tools = registryWith(description).toProviderTools();
    const cells = [];
    for (const prompt of Object.values(PROMPTS)) {
      let called = 0;
      for (let i = 0; i < TRIALS; i++) {
        const reply = await provider.chat([{ role: 'user', content: prompt }], tools);
        if (reply.toolCalls.some((c) => c.name === 'lookup')) called++;
      }
      cells.push(`${called}/${TRIALS}`.padEnd(16));
    }
    console.log(`${String(think).padEnd(8)}  ${label.padEnd(11)}  ${cells.join('  ')}`);
  }
}
