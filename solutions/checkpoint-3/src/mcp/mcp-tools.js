// src/mcp/mcp-tools.js — expose an MCP server's tools as ordinary harness tools (Day 23).
import { truncateText } from '../tools/truncate.js';

/**
 * Every MCP tool:
 *   - is named  mcp__<server>__<tool>  (collision-proof across servers; only [A-Za-z0-9_.-])
 *   - NEEDS APPROVAL by default: the spec says hosts must get consent before invoking tools, and a
 *     server's own claims (annotations like readOnlyHint) are untrusted unless you trust the server
 *   - has a description prefixed with its origin, so the model (and you) can see where it came from
 *
 * @param {import('../tools/tool-registry.js').ToolRegistry} registry
 * @param {import('./mcp-client.js').McpClient} client
 * @param {{ trustReadOnlyHints?: boolean, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<{ names: string[], unregister: () => void }>}
 */
export async function registerMcpTools(registry, client, { trustReadOnlyHints = false, onWarn = (m) => console.warn(m) } = {}) {
  const tools = await client.listTools();
  const undos = [];
  const names = [];
  const seen = new Set();
  for (const t of tools) {
    const name = mcpToolName(client.name, t.name);
    // Two of a server's tools can collide after sanitizing (e.g. "search notes" and "search_notes" both
    // → ...__search_notes). Skip the duplicate with a warning rather than throwing — one odd tool must not
    // take down the whole server (which would leave the tools already registered bound to a dead client).
    if (seen.has(name) || registry.getTool(name)) { onWarn(`mcp ${client.name}: skipping tool "${t.name}" — name "${name}" is already taken`); continue; }
    seen.add(name);
    const readOnly = trustReadOnlyHints && t.annotations?.readOnlyHint === true;
    const schema = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : { type: 'object' };
    if (schema.type !== 'object') schema.type = 'object';
    undos.push(registry.registerTool({
      name,
      label: `${client.name}: ${t.title ?? t.name}`,
      description: `[MCP server "${client.name}"] ${t.description ?? t.title ?? t.name}`.slice(0, 1024),
      parameters: schema,
      needsApproval: !readOnly,
      readOnly,
      async execute(args, { signal } = {}) {
        try {
          const r = await client.callTool(t.name, args, { signal });
          const text = r.content.map(renderContent).join('\n') || (r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : '(empty result)');
          const out = truncateText(text);
          return { content: out.content, isError: r.isError, details: { server: client.name, tool: t.name, truncated: out.truncated } };
        } catch (err) {
          if (signal?.aborted) return { content: `${name} aborted`, isError: true };
          return { content: `MCP ${client.name}/${t.name} failed: ${err.message}`, isError: true };
        }
      },
    }));
    names.push(name);
  }
  return { names, unregister: () => undos.forEach((u) => u()) };
}

export function mcpToolName(server, tool) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/** MCP content items → text the model can read. Non-text items are described, not dumped. */
function renderContent(item) {
  switch (item?.type) {
    case 'text': return item.text;
    case 'image': return `[image ${item.mimeType ?? ''}, ${item.data?.length ?? 0} base64 chars — not shown]`;
    case 'audio': return `[audio ${item.mimeType ?? ''} — not shown]`;
    case 'resource_link': return `[resource ${item.name ?? ''} ${item.uri}]`;
    case 'resource': return item.resource?.text ?? `[resource ${item.resource?.uri ?? ''}]`;
    default: return JSON.stringify(item);
  }
}
