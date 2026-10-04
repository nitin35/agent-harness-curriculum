// src/shared/tool-schemas.js — tool contracts + hand-rolled validators (Day 9).

/**
 * What a tool IS inside the harness.
 * @typedef {object} ToolDefinition
 * @property {string} name              unique; letters, digits, _ . - only (what every provider accepts)
 * @property {string} [label]           human-friendly name for the UI
 * @property {string} description       written FOR THE MODEL: what it does, when to use it, what it returns
 * @property {object} parameters        JSON Schema of the arguments object ({ type: 'object', … })
 * @property {(args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult|string>} execute
 * @property {boolean} [needsApproval]  harness policy, never sent to the model (Day 12 / Day 20)
 * @property {boolean} [readOnly]       true if the tool cannot change anything (used by permission modes, Day 20)
 */

/**
 * @typedef {object} ToolContext
 * @property {AbortSignal} [signal]
 */

/**
 * What a tool RETURNS. Failures are results (isError: true), not exceptions.
 * @typedef {object} ToolResult
 * @property {string} content
 * @property {boolean} isError
 * @property {Record<string, unknown>} [details]  for the UI and logs; never sent to the model
 */

// executeTool receives a ToolCall from message-schemas.js. One vocabulary: no second name for the same shape.

/*
 * MALFORMED-ARGUMENTS POLICY (fixed for the whole course; Day 12's executeTool implements it):
 * when arguments are not valid JSON or fail the schema, return
 *   ToolResult { isError: true, content: 'Invalid arguments for <tool>: <reason>. Retry the call with corrected arguments.' }
 * Never throw into the loop, never "fix" the arguments and run anyway, never retry silently.
 */

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * @param {unknown} def
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateToolDefinition(def) {
  if (!def || typeof def !== 'object') return fail(`tool definition must be an object, got ${typeOf(def)}`);
  const d = /** @type {Record<string, unknown>} */ (def);
  if (typeof d.name !== 'string' || !NAME_RE.test(d.name)) {
    return fail(`'name' must be 1-64 chars of letters, digits, _ . - (got ${JSON.stringify(d.name)})`);
  }
  if (typeof d.description !== 'string' || !d.description.trim()) return fail(`'description' must be a non-empty string`);
  if (!d.parameters || typeof d.parameters !== 'object' || Array.isArray(d.parameters)) return fail(`'parameters' must be a JSON Schema object`);
  if (/** @type {any} */ (d.parameters).type !== 'object') return fail(`'parameters.type' must be "object"`);
  if (typeof d.execute !== 'function') return fail(`'execute' must be a function, got ${typeOf(d.execute)}`);
  if (d.needsApproval !== undefined && typeof d.needsApproval !== 'boolean') return fail(`'needsApproval' must be a boolean`);
  return { ok: true };
}

/**
 * @param {unknown} result
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateToolResult(result) {
  if (!result || typeof result !== 'object') return fail(`tool result must be an object, got ${typeOf(result)}`);
  const r = /** @type {Record<string, unknown>} */ (result);
  if (typeof r.content !== 'string') return fail(`'content' must be a string, got ${typeOf(r.content)}`);
  if (typeof r.isError !== 'boolean') return fail(`'isError' must be a boolean, got ${typeOf(r.isError)}`);
  if (r.details !== undefined && (typeof r.details !== 'object' || r.details === null)) return fail(`'details' must be an object`);
  return { ok: true };
}

/**
 * A deliberately small JSON Schema checker: type, required, properties, enum, items.
 * Enough to catch what models actually get wrong. (Ajv is the optional Day 9 stretch.)
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateArguments(schema, value, path = 'arguments') {
  const s = /** @type {any} */ (schema);
  if (s.type && !matchesType(s.type, value)) return fail(`${path} must be ${s.type}, got ${typeOf(value)}`);
  if (s.enum && !s.enum.includes(value)) return fail(`${path} must be one of ${JSON.stringify(s.enum)}`);
  if (s.type === 'object' && value && typeof value === 'object') {
    for (const key of s.required ?? []) {
      if (!(key in value)) return fail(`missing required property '${key}'`);
    }
    // Models invent arguments. A schema that says `additionalProperties: false` gets them refused, by name,
    // with the list of what IS allowed, so the model can correct itself.
    if (s.additionalProperties === false) {
      const allowed = Object.keys(s.properties ?? {});
      const extra = Object.keys(value).find((key) => !allowed.includes(key));
      if (extra !== undefined) return fail(`unexpected property '${extra}' (allowed: ${allowed.join(', ') || 'none'})`);
    }
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in value && value[key] !== undefined) {
        const r = validateArguments(sub, value[key], key);
        if (!r.ok) return r;
      }
    }
  }
  if (s.type === 'array' && Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i++) {
      const r = validateArguments(s.items, value[i], `${path}[${i}]`);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

function matchesType(type, value) {
  if (Array.isArray(type)) return type.some((t) => matchesType(t, value));
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
function fail(error) { return { ok: false, error }; }
