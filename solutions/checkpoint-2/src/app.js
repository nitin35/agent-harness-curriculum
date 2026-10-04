// src/app.js — createApp(): wires every piece together (Day 15; grows on later days).
import { AgentLoop } from './agent/agent-loop.js';
import { EventBus } from './events/event-bus.js';
import { OllamaProvider } from './provider/ollama.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { createBuiltinTools } from './tools/builtin/index.js';
import { Printer } from './ui/printer.js';
import { PromptUI } from './ui/prompt-ui.js';
import { UIBridge } from './bridge.js';

/**
 * @param {{
 *   cwd?: string,
 *   provider?: import('./shared/message-schemas.js').Provider,
 *   input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, terminal?: boolean,
 *   color?: 'auto'|'always'|'never',
 *   onExit?: (code: number) => void,
 *   streaming?: boolean,
 * }} [opts]
 */
export function createApp({ cwd = process.cwd(), provider = new OllamaProvider(), input, output, terminal, color, onExit, streaming = true } = {}) {
  const bus = new EventBus();
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools({ root: cwd })) registry.registerTool(tool);

  const printer = new Printer({ out: output ?? process.stdout, color });
  const ui = new PromptUI({ input, output, printer, bus, terminal, onExit: (code) => app.stop(code) });

  // Day 15's approval: one y/N question through the UI's readline (the single stdin owner).
  // Day 20 replaces this with the full approval gate + permission rules.
  const approve = async (call, tool, { signal }) => {
    const answer = await ui.ask(`  allow ${call.name} ${JSON.stringify(call.arguments)}? [y/N] `, { signal });
    return answer.trim().toLowerCase() === 'y';
  };

  const loop = new AgentLoop({ provider, registry, approve, streaming, emit: (event, payload) => bus.emit(event, payload) });
  const bridge = new UIBridge({
    bus, loop, ui,
    onCommand: (line) => {
      if (line === '/quit') return app.stop(0);
      ui.printSystem(`unknown command ${line} (slash commands arrive on Day 18)`);
    },
  });

  const app = {
    bus, registry, provider, loop, ui, bridge, printer,
    stopped: false,
    exitCode: 0,
    start() {
      printer.printSystem(`agent-harness · ${provider.model} · ${cwd}`);
      printer.printSystem('Ctrl+C aborts a run (twice exits) · /quit leaves');
      ui.start();
    },
    /** @param {number} [code] */
    stop(code = 0) {
      if (app.stopped) return;
      app.stopped = true;
      app.exitCode = code;
      bridge.abort();
      bridge.dispose();
      ui.stop();
      (onExit ?? ((c) => { process.exitCode = c; }))(code);
    },
  };
  return app;
}
