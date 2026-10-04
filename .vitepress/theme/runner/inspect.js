// .vitepress/theme/runner/inspect.js — show a value the way Node's REPL would.
//
// A small stand-in for Node's util.inspect, so that results in the browser look like the `// → value`
// comments in the course: [ 1, 2, 3 ], { a: 1 }, 'text', Map(1) { 'a' => 1 }, [Function: f].
// This file must not import anything: its source text is copied into the sandbox's worker.

export function inspect(value, depth = 0, seen = new Set()) {
  const t = typeof value;
  if (value === null) return 'null';
  if (t === 'undefined') return 'undefined';
  if (t === 'string') return quote(value);
  if (t === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (t === 'bigint') return `${value}n`;
  if (t === 'boolean') return String(value);
  if (t === 'symbol') return value.toString();
  if (t === 'function') {
    const src = Function.prototype.toString.call(value);
    if (/^class[\s{]/.test(src)) return `[class ${value.name || '(anonymous)'}]`;
    const kind = value.constructor?.name === 'AsyncFunction' ? 'AsyncFunction'
      : value.constructor?.name === 'GeneratorFunction' ? 'GeneratorFunction'
        : value.constructor?.name === 'AsyncGeneratorFunction' ? 'AsyncGeneratorFunction' : 'Function';
    return `[${kind}: ${value.name || '(anonymous)'}]`;
  }
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (value instanceof Promise) return 'Promise { … }';
  if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';

  seen.add(value);
  try {
    const inner = (v) => inspect(v, depth + 1, seen);
    if (Array.isArray(value)) {
      const items = [];
      for (let i = 0; i < value.length; i++) items.push(i in value ? inner(value[i]) : '<empty>');
      return items.length ? `[ ${items.join(', ')} ]` : '[]';
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const name = value.constructor.name;
      return `${name}(${value.length}) [ ${Array.from(value).join(', ')} ]`;
    }
    if (value instanceof Map) {
      const items = [...value].map(([k, v]) => `${inner(k)} => ${inner(v)}`);
      return `Map(${value.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
    }
    if (value instanceof Set) {
      const items = [...value].map(inner);
      return `Set(${value.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
    }
    const proto = Object.getPrototypeOf(value);
    const name = proto === null ? '[Object: null prototype]' : proto === Object.prototype ? '' : (proto.constructor?.name ?? '');
    const keys = Reflect.ownKeys(value).filter((k) => Object.getOwnPropertyDescriptor(value, k)?.enumerable);
    const entries = keys.map((k) => {
      const d = Object.getOwnPropertyDescriptor(value, k);
      const shown = 'get' in d || 'set' in d ? (d.get && d.set ? '[Getter/Setter]' : d.get ? '[Getter]' : '[Setter]') : inner(value[k]);
      return `${key(k)}: ${shown}`;
    });
    const body = entries.length ? `{ ${entries.join(', ')} }` : '{}';
    return name ? `${name} ${body}` : body;
  } finally {
    seen.delete(value);
  }
}

function quote(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(new RegExp(q, 'g'), `\\${q}`) + q;
}

function key(k) {
  if (typeof k === 'symbol') return `[${k.toString()}]`;
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k);
}

/** An error the way the course writes one: `TypeError: Cannot read properties of undefined`. */
export function describeError(err) {
  if (err instanceof Error || (err && typeof err === 'object' && 'name' in err && 'message' in err)) {
    return `${err.name}: ${err.message}`;
  }
  return `Uncaught ${inspect(err)}`;
}
