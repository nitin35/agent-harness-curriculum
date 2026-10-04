// src/session/jsonl-utils.js — append, read, and atomically rewrite JSONL files (Day 17).
import fs from 'node:fs/promises';
import path from 'node:path';

// Sessions hold everything the tools printed (file contents, command output), so they are private:
// the folders are created 0o700 and the files 0o600 (owner only). Both apply when a file is created.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Append one record as one line. Always '\n' (never os.EOL) so files are portable. */
export async function appendJsonl(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: FILE_MODE });
}

/**
 * Read every record. A line that does not parse (a crash tore it mid-write) is skipped with a
 * warning — losing one torn line beats losing the session.
 * `tornTail` says the file doesn't end in '\n': the next append must start with one, or it would
 * be glued onto the torn line and lost with it.
 * @param {string} filePath
 * @param {{ onWarn?: (msg: string) => void }} [opts]
 * @returns {Promise<{ records: any[], skipped: number, tornTail: boolean }>}
 */
export async function readJsonl(filePath, { onWarn = (m) => console.warn(m) } = {}) {
  const text = await fs.readFile(filePath, 'utf8');
  const records = [];
  let skipped = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      skipped++;
      onWarn(`jsonl: skipped corrupt line ${i + 1} in ${filePath}`);
    }
  }
  return { records, skipped, tornTail: text.length > 0 && !text.endsWith('\n') };
}

/**
 * Replace the whole file atomically: write a temp file NEXT TO the target, then rename over it.
 * rename() is atomic within one filesystem, so readers see the old file or the new one, never half.
 * (Without fsync a power cut can still lose the newest data — an accepted tradeoff here.)
 */
export async function writeJsonlAtomic(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(''), { encoding: 'utf8', mode: FILE_MODE });
  await fs.rename(tmp, filePath);
}

/** Read only the first line (headers are cheap to list). Returns null for an empty/missing file. */
export async function readFirstLine(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    const first = nl === -1 ? text : text.slice(0, nl);
    return first.trim() ? first : null;
  } finally {
    await fh.close();
  }
}
