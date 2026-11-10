import { readdir, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Read-only view over the Claude Code session registry
 * (`~/.claude/sessions/*.json`). The registry is CC-external state, not a
 * claudian contract: a shape change degrades to "no suffix rendered", never
 * to a broken list. Injected so tests never touch the real filesystem.
 */
export interface SessionRegistryReader {
  /** Directory listing; rejects when the directory is missing/unreadable. */
  listJsonFiles(dir: string): Promise<string[]>;
  /** UTF-8 file read; per-file rejections only skip that file. */
  readTextFile(filePath: string): Promise<string>;
}

/** Registry default location, resolved per call so tests can patch HOME. */
export function defaultSessionsDir(): string {
  return path.join(os.homedir(), '.claude', 'sessions');
}

const defaultSessionRegistryReader: SessionRegistryReader = {
  // Non-JSON siblings (e.g. peer key files) share the directory; only *.json
  // files are snapshots.
  listJsonFiles: async (dir) => (await readdir(dir)).filter((name) => name.endsWith('.json')),
  readTextFile: (filePath) => readFile(filePath, 'utf8'),
};

// procStart is time.ctime() text ("Mon Nov  9 01:46:55 2026"); Date.parse is
// implementation-defined on that shape, so parse it explicitly (local time,
// matching CC's writer) and fall back to startedAt (epoch ms).
const PROC_START_PATTERN = /^[A-Za-z]{3} ([A-Za-z]{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function procStartKey(data: Record<string, unknown>): number | null {
  const procStart = data.procStart;
  if (typeof procStart === 'string') {
    const match = PROC_START_PATTERN.exec(procStart);
    if (match) {
      const month = MONTHS.indexOf(match[1]);
      if (month !== -1) {
        const date = new Date(
          Number(match[6]), month, Number(match[2]),
          Number(match[3]), Number(match[4]), Number(match[5]),
        );
        const time = date.getTime();
        if (!Number.isNaN(time)) return time;
      }
    }
  }
  const startedAt = data.startedAt;
  if (typeof startedAt === 'number' && !Number.isNaN(startedAt)) return startedAt;
  return null;
}

/**
 * Scans the registry directory once and returns sessionId → name.
 * Registry scale is the active-process count, so no caching: scan per use.
 * Broken JSON, non-object payloads, and entries missing sessionId or name are
 * skipped without affecting the rest. Multiple snapshots of one UUID (one
 * session, several processes) resolve to the newest procStart snapshot.
 */
export async function loadActiveSessionNames(
  reader: SessionRegistryReader = defaultSessionRegistryReader,
  dir: string = defaultSessionsDir(),
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const keys = new Map<string, number | null>();

  let entries: string[];
  try {
    entries = (await reader.listJsonFiles(dir)).sort();
  } catch {
    return names;
  }

  for (const entry of entries) {
    let data: unknown;
    try {
      data = JSON.parse(await reader.readTextFile(path.join(dir, entry)));
    } catch {
      continue;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue;
    const record = data as Record<string, unknown>;
    const sessionId = record.sessionId;
    const name = record.name;
    if (typeof sessionId !== 'string' || !sessionId || typeof name !== 'string' || !name) continue;

    const key = procStartKey(record);
    if (keys.has(sessionId)) {
      const prev = keys.get(sessionId) ?? null;
      // An already-sortable snapshot only yields to a strictly newer one; an
      // unsortable snapshot is replaced unconditionally.
      if (prev !== null && (key === null || key <= prev)) continue;
    }
    keys.set(sessionId, key);
    names.set(sessionId, name);
  }

  return names;
}

/**
 * Renders the session identity suffix `name · sessionId[0..8]`. Either input
 * empty → '' so callers skip the whole suffix (never a dangling separator).
 */
export function formatActiveSessionIdentity(sessionId: string, name: string): string {
  if (!sessionId || !name) return '';
  return `${name} · ${sessionId.slice(0, 8)}`;
}
