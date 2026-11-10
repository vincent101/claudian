import {
  formatActiveSessionIdentity,
  loadActiveSessionNames,
  type SessionRegistryReader,
} from '@/features/chat/utils/sessionIdentity';

function createFakeReader(
  files: Record<string, string>,
  listError?: Error,
): SessionRegistryReader {
  return {
    listJsonFiles: async (dir: string) => {
      if (listError) throw listError;
      return Object.keys(files)
        .filter((name) => name.endsWith('.json'))
        .map((name) => `${dir}/${name}`);
    },
    readTextFile: async (filePath: string) => {
      const name = filePath.split('/').pop() ?? '';
      const body = files[name];
      if (body === undefined) throw new Error(`missing file: ${name}`);
      return body;
    },
  };
}

describe('sessionIdentity', () => {
  describe('loadActiveSessionNames', () => {
    it('maps a single registry snapshot to its session name', async () => {
      const reader = createFakeReader({
        '100.json': JSON.stringify({ sessionId: 'uuid-1', name: 'notevault-8b', procStart: 'Mon Nov  9 01:46:55 2026' }),
      });

      const names = await loadActiveSessionNames(reader, '/fake/sessions');

      expect(names.size).toBe(1);
      expect(names.get('uuid-1')).toBe('notevault-8b');
    });

    it('keeps the newest procStart snapshot when a UUID has several files', async () => {
      const reader = createFakeReader({
        '100.json': JSON.stringify({ sessionId: 'uuid-1', name: 'stale-name', procStart: 'Mon Nov  9 01:00:00 2026' }),
        '200.json': JSON.stringify({ sessionId: 'uuid-1', name: 'fresh-name', procStart: 'Mon Nov  9 02:00:00 2026' }),
      });

      const names = await loadActiveSessionNames(reader, '/fake/sessions');

      expect(names.get('uuid-1')).toBe('fresh-name');
    });

    it('falls back to startedAt ordering when procStart is missing', async () => {
      const reader = createFakeReader({
        '100.json': JSON.stringify({ sessionId: 'uuid-1', name: 'stale-name', startedAt: 1000 }),
        '200.json': JSON.stringify({ sessionId: 'uuid-1', name: 'fresh-name', startedAt: 2000 }),
      });

      const names = await loadActiveSessionNames(reader, '/fake/sessions');

      expect(names.get('uuid-1')).toBe('fresh-name');
    });

    it('skips broken JSON and entries missing sessionId or name without affecting the rest', async () => {
      const reader = createFakeReader({
        'bad.json': '{not valid json',
        'no-session.json': JSON.stringify({ name: 'orphan' }),
        'empty-session.json': JSON.stringify({ sessionId: '', name: 'blank-sid' }),
        'no-name.json': JSON.stringify({ sessionId: 'uuid-2' }),
        'not-object.json': '["array"]',
        'key-file.key': JSON.stringify({ sessionId: 'uuid-3', name: 'ignored' }),
        'good.json': JSON.stringify({ sessionId: 'uuid-4', name: 'kept-name' }),
      });

      const names = await loadActiveSessionNames(reader, '/fake/sessions');

      expect(names.size).toBe(1);
      expect(names.get('uuid-4')).toBe('kept-name');
    });

    it('replaces an unsortable earlier snapshot unconditionally, but keeps a keyed one over a later unkeyed file', async () => {
      const unkeyedFirst = createFakeReader({
        '100.json': JSON.stringify({ sessionId: 'uuid-1', name: 'unkeyed-name' }),
        '200.json': JSON.stringify({ sessionId: 'uuid-1', name: 'keyed-name', procStart: 'Mon Nov  9 01:00:00 2026' }),
      });
      await expect(loadActiveSessionNames(unkeyedFirst, '/fake/sessions'))
        .resolves.toEqual(new Map([['uuid-1', 'keyed-name']]));

      const unkeyedLater = createFakeReader({
        '100.json': JSON.stringify({ sessionId: 'uuid-1', name: 'keyed-name', procStart: 'Mon Nov  9 01:00:00 2026' }),
        '200.json': JSON.stringify({ sessionId: 'uuid-1', name: 'unkeyed-name' }),
      });
      await expect(loadActiveSessionNames(unkeyedLater, '/fake/sessions'))
        .resolves.toEqual(new Map([['uuid-1', 'keyed-name']]));
    });

    it('returns an empty map when the registry directory is missing', async () => {
      const reader = createFakeReader({}, new Error('ENOENT'));

      const names = await loadActiveSessionNames(reader, '/fake/sessions');

      expect(names.size).toBe(0);
    });
  });

  describe('formatActiveSessionIdentity', () => {
    it('formats name and uuid8 from complete inputs', () => {
      expect(formatActiveSessionIdentity('02a240bd-1111-2222-3333-444444444444', 'notevault-8b'))
        .toBe('notevault-8b · 02a240bd');
    });

    it('returns an empty string when either input is empty', () => {
      expect(formatActiveSessionIdentity('', 'notevault-8b')).toBe('');
      expect(formatActiveSessionIdentity('02a240bd-1111-2222-3333-444444444444', '')).toBe('');
      expect(formatActiveSessionIdentity('', '')).toBe('');
    });
  });
});
