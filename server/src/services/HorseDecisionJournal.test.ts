import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  chmodSync,
  rmSync,
  readFileSync,
  statSync,
  symlinkSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  linkSync,
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite');
import {
  HorseDecisionJournalStore,
  horseJournalCapacityReason,
} from './horseDecisionJournal/store.js';
import {
  horseJournalJson,
  journalHash,
  makeHorseJournalRecord,
  validateHorseJournalRecord,
  type HorseJournalRecord,
} from './horseDecisionJournal/record.js';
import {
  HorseDecisionJournalPublisher,
  horseDecisionJournalHealth,
  relayHorseDecisionJournalHealth,
  type HorseJournalWorker,
} from './HorseDecisionJournal.js';

const folders: string[] = [],
  stores: HorseDecisionJournalStore[] = [];
const folder = () => {
  const p = mkdtempSync(join(tmpdir(), 'horse-journal-test-'));
  folders.push(p);
  return p;
};
const store = (
  dir: string,
  limits?: ConstructorParameters<typeof HorseDecisionJournalStore>[1]
) => {
  const s = new HorseDecisionJournalStore(dir, limits);
  stores.push(s);
  return s;
};
const record = (
  sequence = 1,
  payload: unknown = { privateSyntheticCard: 'As' }
): HorseJournalRecord =>
  makeHorseJournalRecord(
    {
      producerId: '10000000-0000-4000-8000-000000000001',
      sequence,
      atMs: 1000,
      sourceRelease: null,
      kind: 'decision',
      handKey: journalHash('hand'),
      turnKey: journalHash('turn'),
    },
    payload
  );
afterEach(() => {
  for (const s of stores.splice(0))
    try {
      s.close();
    } catch {
      /* already closed by the test */
    }
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('private durable Horse journal storage', () => {
  it.each([
    { atMs: 1001 },
    { sourceRelease: 'a'.repeat(40) },
    { kind: 'execution' },
    { handKey: 'b'.repeat(64) },
    { turnKey: 'c'.repeat(64) },
  ])('binds all record metadata as well as the body: %j', (change) => {
    expect(() => validateHorseJournalRecord({ ...record(), ...change })).toThrow('Invalid');
  });
  it('retains exact immutable bytes after commit and fresh connection replay', () => {
    const dir = folder(),
      a = store(dir),
      value = record();
    expect(a.append(value)).toBe('recorded');
    a.close();
    const b = store(dir);
    expect(b.append(structuredClone(value))).toBe('replayed');
    expect(b.readHand(value.handKey)).toEqual([value]);
    expect(statSync(join(dir, 'horse-decisions.sqlite')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
  it('reproduces an accepted write in a separate Node process after a lost acknowledgement', () => {
    const dir = folder(),
      value = record();
    const module = new URL('./horseDecisionJournal/store.ts', import.meta.url).href;
    const script = `import { HorseDecisionJournalStore, horseJournalCapacityReason } from ${JSON.stringify(module)};const s=new HorseDecisionJournalStore(process.argv[1]);s.append(JSON.parse(process.argv[2]));process.exit(0);`;
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, dir, JSON.stringify(value)],
      { stdio: 'pipe' }
    );
    const restored = store(dir);
    expect(restored.append(value)).toBe('replayed');
    expect(restored.readHand(value.handKey)).toEqual([value]);
  });
  it('refuses changed bytes for an existing producer/sequence without losing the old event', () => {
    const s = store(folder()),
      first = record();
    s.append(first);
    expect(() => s.append(record(1, { privateSyntheticCard: 'Kd' }))).toThrow('identity conflict');
    expect(s.readHand(first.handKey)).toEqual([first]);
    expect(s.append(record(2))).toBe('recorded');
  });
  it('competing connections replay once and keep cumulative capacity atomic', () => {
    const dir = folder(),
      a = store(dir, { maxRecords: 1 }),
      b = store(dir, { maxRecords: 1 }),
      value = record();
    a.append(value);
    expect(b.append(value)).toBe('replayed');
    expect(() => b.append(record(2))).toThrow('capacity');
    expect(a.readHand(value.handKey)).toEqual([value]);
  });
  it('refuses byte exhaustion without replacing existing evidence', () => {
    const s = store(folder(), { maxBytes: 1 });
    expect(() => s.append(record())).toThrow('capacity');
    expect(s.readHand(journalHash('hand'))).toEqual([]);
  });
  it('refuses corruption on read instead of treating it as an empty history', () => {
    const dir = folder(),
      s = store(dir),
      value = record();
    s.append(value);
    const native = new DatabaseSync(join(dir, 'horse-decisions.sqlite'));
    native.prepare('UPDATE horse_journal_events SET record_json=?').run('{}');
    native.close();
    expect(() => s.readHand(value.handKey)).toThrow('corruption');
  });
  it('refuses a busy writer and recovers the identical record after rollback', () => {
    const dir = folder(),
      s = store(dir),
      native = new DatabaseSync(join(dir, 'horse-decisions.sqlite'));
    native.exec('BEGIN IMMEDIATE');
    expect(() => s.append(record())).toThrow();
    native.exec('ROLLBACK');
    native.close();
    expect(s.append(record())).toBe('recorded');
  });
  it('will not open a shared directory or a symlink to another file', () => {
    const dir = folder();
    chmodSync(dir, 0o755);
    expect(() => store(dir)).toThrow('not private');
    chmodSync(dir, 0o700);
    symlinkSync('/etc/hosts', join(dir, 'horse-decisions.sqlite'));
    expect(() => store(dir)).toThrow('not private');
  });
  it('refuses foreign schema and preserves its data', () => {
    const dir = folder();
    const path = join(dir, 'horse-decisions.sqlite');
    const native = new DatabaseSync(path);
    native.exec("CREATE TABLE foreign_data(x TEXT); INSERT INTO foreign_data VALUES('preserve');");
    native.close();
    chmodSync(path, 0o600);
    expect(() => store(dir)).toThrow('Foreign');
    const verify = new DatabaseSync(path);
    expect(verify.prepare('SELECT x FROM foreign_data').get()!.x).toBe('preserve');
    verify.close();
  });
  it('bounds a hand read and does not truncate it to a false complete result', () => {
    const s = store(folder());
    for (let i = 1; i <= 257; i += 16)
      s.appendBatch(Array.from({ length: Math.min(16, 258 - i) }, (_, j) => record(i + j)));
    expect(() => s.readHand(journalHash('hand'))).toThrow('bounds');
  });
  it('rolls back every new event and its usage when the last batch member conflicts', () => {
    const s = store(folder(), { maxRecords: 3 }),
      first = record();
    s.append(first);
    expect(() => s.appendBatch([record(2), record(1, { changed: true })])).toThrow('conflict');
    expect(s.readHand(first.handKey)).toEqual([first]);
    expect(s.appendBatch([record(2), record(3)])).toEqual(['recorded', 'recorded']);
  });
  it.each([NaN, Infinity, new Map(), new Set(), new Date(), [undefined], () => 0, 1n])(
    'rejects nonportable input %s',
    (value) => expect(() => horseJournalJson(value)).toThrow()
  );
  it.each([
    'sha256',
    'body',
    'bytes',
    'eventId',
    'sourceRelease',
    'sequence',
    'handKey',
    'turnKey',
    'kind',
    'version',
  ])('rejects altered %s', (key) => {
    const value = { ...record(), [key]: 'bad' };
    expect(() => validateHorseJournalRecord(value)).toThrow();
  });
});

class FakeWorker implements HorseJournalWorker {
  sent: Array<Parameters<HorseJournalWorker['postMessage']>[0]> = [];
  listeners = new Map<string, (v: any) => void>();
  terminate = vi.fn(async () => 0);
  postMessage(message: Parameters<HorseJournalWorker['postMessage']>[0]) {
    this.sent.push(message);
  }
  on(event: string, callback: (value: any) => void) {
    this.listeners.set(event, callback);
  }
  emit(message: any) {
    this.listeners.get('message')?.(message);
  }
}
describe('bounded isolated Horse journal publisher', () => {
  it('retains the immutable head until its exact durable ACK then drains before stop', async () => {
    const w = new FakeWorker(),
      notes: string[] = [],
      p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x));
    const payload = { value: 1 };
    p.record('decision', 'hand', 'turn', payload);
    payload.value = 2;
    expect(w.sent).toEqual([]);
    w.emit({ type: 'READY' });
    const first = (w.sent[0] as { records: HorseJournalRecord[] }).records[0]!;
    expect(JSON.parse(first.body)).toEqual({ value: 1 });
    p.record('execution', 'hand', 'turn', { value: 3 });
    expect(w.sent).toHaveLength(1);
    const stopping = p.stop();
    expect(w.sent).toHaveLength(1);
    w.emit({
      type: 'ACK',
      receipts: [{ eventId: first.eventId, sha256: first.sha256, status: 'recorded' }],
    });
    const second = (w.sent[1] as { records: HorseJournalRecord[] }).records[0]!;
    w.emit({
      type: 'ACK',
      receipts: [{ eventId: second.eventId, sha256: second.sha256, status: 'replayed' }],
    });
    expect(w.sent[2]).toEqual({ type: 'STOP' });
    w.emit({ type: 'STOPPED' });
    await stopping;
    expect(notes).toEqual([
      'phase15_journal_enqueued',
      'phase15_journal_enqueued',
      'phase15_journal_recorded',
      'phase15_journal_replayed',
    ]);
  });
  it.each(['wrong_id', 'wrong_hash', 'unavailable'])(
    'does not claim a durable write from %s',
    async (mode) => {
      const w = new FakeWorker(),
        notes: string[] = [],
        p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x));
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'READY' });
      const head = (w.sent[0] as { records: HorseJournalRecord[] }).records[0]!;
      w.emit(
        mode === 'unavailable'
          ? { type: 'UNAVAILABLE' }
          : {
              type: 'ACK',
              receipts: [
                {
                  eventId: mode === 'wrong_id' ? 'wrong' : head.eventId,
                  sha256: mode === 'wrong_hash' ? 'wrong' : head.sha256,
                  status: 'recorded',
                },
              ],
            }
      );
      expect(notes).not.toContain('phase15_journal_recorded');
      expect(notes).toContain('phase15_journal_unavailable');
      await p.stop();
    }
  );
  it('makes queue capacity and missing hand identity explicit', async () => {
    const w = new FakeWorker(),
      notes: string[] = [],
      p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x));
    for (let i = 0; i < 65; i++) p.record('decision', 'hand', 'turn', {});
    p.record('decision', null, 'turn', {});
    expect(notes.filter((x) => x === 'phase15_journal_enqueued')).toHaveLength(64);
    expect(notes).toContain('phase15_journal_queue_capacity');
    expect(notes).toContain('phase15_journal_capture_unavailable');
    w.emit({ type: 'UNAVAILABLE' });
    await p.stop();
  });
  it('bounds an unacknowledged writer and shutdown without calling it durable', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker(),
      notes: string[] = [],
      p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x));
    p.record('decision', 'hand', 'turn', {});
    w.emit({ type: 'READY' });
    const stop = p.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stop;
    expect(notes).toContain('phase15_journal_shutdown_unverified');
    expect(notes).not.toContain('phase15_journal_recorded');
    expect(w.terminate).toHaveBeenCalledOnce();
  });
});

describe('bounded immutable Horse archive custody', () => {
  const options = (dir: string, patch = {}) => ({
    directory: join(dir, 'archive'),
    maxBytes: 1024 * 1024,
    maxSegments: 100,
    ...patch,
  });
  const catalog = (dir: string) =>
    new DatabaseSync(join(dir, 'archive', 'horse-journal-archive.sqlite'));
  const recordForHand = (sequence: number, hand: string): HorseJournalRecord =>
    makeHorseJournalRecord(
      {
        producerId: record().producerId,
        sequence,
        atMs: 1000,
        sourceRelease: null,
        kind: 'decision',
        handKey: journalHash(hand),
        turnKey: record().turnKey,
      },
      { synthetic: true }
    );
  it('releases the catalog snapshot before segment I/O without mixing later writer commits', () => {
    const dir = folder(),
      writer = store(dir, { archive: options(dir) }),
      first = recordForHand(1, 'committed'),
      later = recordForHand(2, 'committed');
    writer.append(first);
    const reader = store(dir, { readOnly: true, archive: options(dir) });
    const original = (reader as any).readSegment.bind(reader);
    const read = vi.spyOn(reader as any, 'readSegment').mockImplementationOnce((meta) => {
      // A real second SQLite connection must commit while this reader performs
      // file/decompression work. DELETE journaling and busy_timeout stay real.
      expect(writer.append(later)).toBe('recorded');
      return original(meta);
    });
    try {
      expect(reader.readHand(first.handKey)).toEqual([first]);
      expect(read).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
    }
    expect(reader.readHand(first.handKey)).toEqual([first, later]);
  });
  it.each(['committed', 'unrelated'])(
    'retains captured pending %s custody after a writer finishes before decoding',
    (pendingHand) => {
      const dir = folder(),
        writer = store(dir, { archive: options(dir) }),
        native = catalog(dir),
        first = recordForHand(1, 'committed'),
        pending = recordForHand(2, pendingHand);
      writer.append(first);
      try {
        native.exec(
          "CREATE TRIGGER fail_index BEFORE INSERT ON archive_events BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;"
        );
        expect(() => writer.append(pending)).toThrow('synthetic interruption');
        const reader = store(dir, { readOnly: true, archive: options(dir) });
        const original = (reader as any).readPendingSegments.bind(reader);
        const decode = vi
          .spyOn(reader as any, 'readPendingSegments')
          .mockImplementationOnce((rows) => {
            native.exec('DROP TRIGGER fail_index');
            expect(writer.append(pending)).toBe('replayed');
            return original(rows);
          });
        try {
          if (pendingHand === 'committed')
            expect(() => reader.readHand(first.handKey)).toThrow('Horse archive custody pending');
          else expect(reader.readHand(first.handKey)).toEqual([first]);
          expect(decode).toHaveBeenCalledOnce();
        } finally {
          decode.mockRestore();
        }
        expect(reader.storageStats().archive?.pendingSegments).toBe(0);
        expect(reader.readHand(first.handKey)).toEqual(
          pendingHand === 'committed' ? [first, pending] : [first]
        );
      } finally {
        native.close();
      }
    }
  );
  it.each([false, true])(
    'reads an unrelated committed hand during pending custody (readOnly=%s)',
    (readOnly) => {
      const dir = folder(),
        writer = store(dir, { archive: options(dir) }),
        native = catalog(dir);
      const committed = recordForHand(1, 'committed'),
        pending = recordForHand(2, 'pending');
      writer.append(committed);
      try {
        native.exec(
          "CREATE TRIGGER fail_index BEFORE INSERT ON archive_events BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;"
        );
        expect(() => writer.append(pending)).toThrow('synthetic interruption');
        const reader = readOnly ? store(dir, { readOnly: true, archive: options(dir) }) : writer;
        const reserved = reader.storageStats();
        expect(reader.readHand(committed.handKey)).toEqual([committed]);
        expect(() => reader.readHand(pending.handKey)).toThrow('Horse archive custody pending');
        expect(reader.storageStats()).toEqual(reserved);
        native.exec('DROP TRIGGER fail_index');
        expect(writer.append(pending)).toBe('replayed');
        expect(reader.readHand(pending.handKey)).toEqual([pending]);
        expect(reader.readHand(committed.handKey)).toEqual([committed]);
      } finally {
        native.close();
      }
    }
  );
  it.each([
    ['compressed', "UPDATE archive_pending SET compressed=x'00'", 'segment corruption'],
    ['digest', "UPDATE archive_pending SET sha='" + '0'.repeat(64) + "'", 'segment corruption'],
    ['record count', 'UPDATE archive_pending SET records=17', 'pending exceeds bounds'],
    [
      'compressed bound',
      'UPDATE archive_pending SET compressed=zeroblob(4259841)',
      'pending exceeds bounds',
    ],
  ])('refuses unrelated reads when pending %s is malformed', (_name, sql, failure) => {
    const dir = folder(),
      writer = store(dir, { archive: options(dir) }),
      native = catalog(dir);
    const committed = recordForHand(1, 'committed');
    writer.append(committed);
    try {
      native.exec(
        "CREATE TRIGGER fail_index BEFORE INSERT ON archive_events BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;"
      );
      expect(() => writer.append(recordForHand(2, 'pending'))).toThrow('synthetic interruption');
      native.exec(sql);
      const reader = store(dir, { readOnly: true, archive: options(dir) });
      expect(() => reader.readHand(committed.handKey)).toThrow(failure);
      expect(reader.storageStats().archive?.pendingSegments).toBe(1);
    } finally {
      native.close();
    }
  });
  it.each(['selected', 'corrupt'] as const)(
    'validates the second pending segment when it is %s',
    (second) => {
      const dir = folder(),
        writer = store(dir, { archive: options(dir) }),
        native = catalog(dir);
      const committed = recordForHand(1, 'committed');
      writer.append(committed);
      try {
        native.exec(
          "CREATE TRIGGER fail_index BEFORE INSERT ON archive_events BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;"
        );
        expect(() => writer.append(recordForHand(2, 'pending'))).toThrow('synthetic interruption');
        // Populate the second permitted slot with a fully bound synthetic record.
        // The first slot is valid and unrelated; it cannot authorize early success.
        const original = horseJournalJson(recordForHand(3, 'committed')) + '\n';
        const compressed = gzipSync(original);
        const compressedSha = createHash('sha256').update(compressed).digest('hex');
        native
          .prepare('INSERT INTO archive_pending VALUES(2,?,?,?,?,?,?)')
          .run(
            journalHash(original),
            second === 'corrupt' ? '0'.repeat(64) : compressedSha,
            compressed.length,
            Buffer.byteLength(original),
            1,
            compressed
          );
        const reader = store(dir, { readOnly: true, archive: options(dir) });
        expect(() => reader.readHand(committed.handKey)).toThrow(
          second === 'selected' ? 'Horse archive custody pending' : 'segment corruption'
        );
        expect(reader.storageStats().archive?.pendingSegments).toBe(2);
      } finally {
        native.close();
      }
    }
  );
  it('charges unrelated pending decoding to the existing total read-work budget', () => {
    const dir = folder(),
      writer = store(dir, { archive: options(dir) }),
      native = catalog(dir);
    const committedKey = journalHash('hand');
    const rowsForBatch = (batch: number, includeTarget: boolean) => {
      const rows = includeTarget ? [record(batch * 10 + 1)] : [];
      for (let i = 2; i <= 8; i++)
        rows.push(
          makeHorseJournalRecord(
            {
              producerId: record().producerId,
              sequence: batch * 10 + i,
              atMs: 1000,
              sourceRelease: null,
              kind: 'decision',
              handKey: journalHash('unrelated'),
              turnKey: record().turnKey,
            },
            { large: 'x'.repeat(490000) }
          )
        );
      return rows;
    };
    try {
      for (let batch = 0; batch < 9; batch++) writer.appendBatch(rowsForBatch(batch, true));
      expect(writer.readHand(committedKey)).toHaveLength(9);
      native.exec(
        "CREATE TRIGGER fail_index BEFORE INSERT ON archive_events BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;"
      );
      expect(() => writer.appendBatch(rowsForBatch(9, false))).toThrow('synthetic interruption');
      const reader = store(dir, { readOnly: true, archive: options(dir) });
      expect(() => reader.readHand(committedKey)).toThrow('archive read exceeds decode bounds');
      expect(reader.storageStats().archive?.pendingSegments).toBe(1);
    } finally {
      native.close();
    }
  });
  it('preserves a full legacy database byte-for-byte and joins original envelopes across restart', () => {
    const dir = folder(),
      legacy = store(dir, { maxRecords: 1 });
    legacy.append(record());
    expect(() => legacy.append(record(2))).toThrow('capacity');
    legacy.close();
    const original = readFileSync(join(dir, 'horse-decisions.sqlite'));
    const s = store(dir, { archive: options(dir) });
    expect(s.appendBatch([record(), record(2)])).toEqual(['replayed', 'recorded']);
    expect(s.readHand(record().handKey)).toEqual([record(), record(2)]);
    const files = readdirSync(join(dir, 'archive', 'segments'));
    expect(files).toHaveLength(1);
    expect(gunzipSync(readFileSync(join(dir, 'archive', 'segments', files[0]!))).toString()).toBe(
      horseJournalJson(record(2)) + '\n'
    );
    expect(statSync(join(dir, 'archive', 'segments', files[0]!)).mode & 0o777).toBe(0o600);
    s.close();
    const reopened = store(dir, { archive: options(dir) });
    expect(reopened.append(record(2))).toBe('replayed');
    expect(readFileSync(join(dir, 'horse-decisions.sqlite'))).toEqual(original);
    expect(reopened.storageStats().archive).toMatchObject({
      records: 1,
      segments: 1,
      pendingSegments: 0,
    });
  });
  it('reads existing archives without applying a new smaller writer quota', () => {
    const dir = folder(),
      a = store(dir, { archive: options(dir) });
    a.append(record());
    a.close();
    const s = store(dir, {
      readOnly: true,
      archive: options(dir, { maxBytes: 1, maxSegments: 1 }),
    });
    expect(s.readHand(record().handKey)).toEqual([record()]);
    expect(s.storageStats().archive).toMatchObject({ maxBytes: 1024 * 1024, maxSegments: 100 });
    expect(() => s.append(record(2))).toThrow('read only');
  });
  it('coordinates competing connections and rejects conflicts atomically across both tiers', () => {
    const dir = folder(),
      legacy = store(dir);
    legacy.append(record());
    legacy.close();
    const a = store(dir, { archive: options(dir) }),
      b = store(dir, { archive: options(dir) });
    expect(a.append(record(2))).toBe('recorded');
    expect(b.append(record(2))).toBe('replayed');
    for (const sequence of [1, 2])
      expect(() => b.appendBatch([record(3), record(sequence, { changed: true })])).toThrow(
        'identity conflict'
      );
    expect(a.readHand(record().handKey)).toEqual([record(), record(2)]);
  });
  it('refuses a batch that could not fit an empty archive without retiring anything', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir, { maxBytes: 1 }) });
    expect(() => s.append(record())).toThrow('byte_capacity');
    expect(s.storageStats().archive).toMatchObject({
      records: 0,
      segments: 0,
      pendingSegments: 0,
      retiredSegments: 0,
    });
    expect(readdirSync(join(dir, 'archive', 'segments'))).toEqual([]);
  });
  it('at the segment quota the ring retires the oldest published segment and records the batch', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir, { maxSegments: 1 }) });
    expect(s.append(record())).toBe('recorded');
    const [first] = readdirSync(join(dir, 'archive', 'segments'));
    expect(s.append(record(2))).toBe('recorded');
    expect(s.readHand(record().handKey)).toEqual([record(2)]);
    expect(s.storageStats().archive).toMatchObject({
      records: 1,
      segments: 1,
      publishedSegments: 1,
      pendingSegments: 0,
      retiredSegments: 1,
      retiredRecords: 1,
    });
    const files = readdirSync(join(dir, 'archive', 'segments'));
    expect(files).toHaveLength(1);
    expect(files).not.toContain(first);
  });
  it('retains a reserved batch after index failure and recovers exact bytes once at reopen', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir) }),
      native = catalog(dir);
    native.exec(
      "CREATE TRIGGER fail_index BEFORE INSERT ON archive_events BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;"
    );
    expect(() => s.appendBatch([record(), record(2)])).toThrow('synthetic interruption');
    expect(s.storageStats().archive).toMatchObject({ records: 2, segments: 1, pendingSegments: 1 });
    expect(() => s.readHand(record().handKey)).toThrow('custody pending');
    const files = readdirSync(join(dir, 'archive', 'segments'));
    expect(files).toHaveLength(1);
    const bytes = readFileSync(join(dir, 'archive', 'segments', files[0]!));
    s.close();
    native.exec('DROP TRIGGER fail_index');
    native.close();
    const recovered = store(dir, { archive: options(dir) });
    expect(recovered.appendBatch([record(), record(2)])).toEqual(['replayed', 'replayed']);
    expect(recovered.storageStats().archive).toMatchObject({
      records: 2,
      segments: 1,
      pendingSegments: 0,
    });
    expect(readFileSync(join(dir, 'archive', 'segments', files[0]!))).toEqual(bytes);
  });
  it('allocates catalog headroom for the existing archive without allocating the file eagerly', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir) });
    const writer = (s as unknown as { catalog: InstanceType<typeof DatabaseSync> }).catalog;
    // Production exhausted 524288 pages at only 262387 of 500000 segments.
    // The 4 GiB that followed covered ~6.7M records at the observed ~639 B
    // each, short of the 8,000,000-record cap; 6 GiB covers the cap (~5.12 GB)
    // with margin, so the named record refusal is reached before SQLITE_FULL.
    const allocation = 6 * 1024 * 1024 * 1024;
    expect(Number(writer.prepare('PRAGMA max_page_count').get()!.max_page_count) * 4096).toBe(
      allocation
    );
    expect(s.storageStats().archive).toMatchObject({
      maxCatalogBytes: allocation,
      // Read back from the writer's own pragma, not repeated from the source.
      appliedMaxCatalogBytes: allocation,
      maxRecords: 100 * 16,
      maxRowid: 0,
    });
    const reader = store(dir, { readOnly: true, archive: options(dir) });
    expect(reader.storageStats().archive).toMatchObject({
      maxCatalogBytes: allocation,
      appliedMaxCatalogBytes: null,
    });
    expect(statSync(join(dir, 'archive', 'horse-journal-archive.sqlite')).size).toBeLessThan(
      1024 * 1024
    );
  });
  it('recovers exact pending custody after real SQLite catalog exhaustion on writer reopen', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir) });
    const writer = (s as unknown as { catalog: InstanceType<typeof DatabaseSync> }).catalog;
    // A test-only index trigger consumes physical pages during publication,
    // after the compressed batch has been reserved. No fake SQLite error.
    writer.exec(`CREATE TABLE capacity_fixture(bytes BLOB);
      CREATE TRIGGER exhaust_index BEFORE INSERT ON archive_events BEGIN
        INSERT INTO capacity_fixture VALUES(zeroblob(524288)); END;`);
    // Enough headroom for the named pre-reservation estimate (under 100
    // pages for two records) and too little for the trigger's 2 x 129 pages.
    const pages = Number(writer.prepare('PRAGMA page_count').get()!.page_count);
    writer.exec(`PRAGMA max_page_count=${pages + 200};`);
    let capacityError: unknown;
    try {
      s.appendBatch([record(), record(2)]);
    } catch (error) {
      capacityError = error;
    }
    expect(capacityError).toMatchObject({ errcode: 13 });
    expect(horseJournalCapacityReason(capacityError)).toBe('archive_storage_capacity');
    expect(s.storageStats().archive).toMatchObject({ records: 2, segments: 1, pendingSegments: 1 });
    expect(() => s.readHand(record().handKey)).toThrow('custody pending');
    const files = readdirSync(join(dir, 'archive', 'segments'));
    expect(files).toHaveLength(1);
    const bytes = readFileSync(join(dir, 'archive', 'segments', files[0]!));
    s.close();
    // The normal source-configured writer opening restores allocation before
    // finishPending. Leave the trigger in place to prove real space is usable.
    const recovered = store(dir, { archive: options(dir) });
    expect(recovered.appendBatch([record(), record(2)])).toEqual(['replayed', 'replayed']);
    expect(recovered.readHand(record().handKey)).toEqual([record(), record(2)]);
    expect(recovered.storageStats().archive).toMatchObject({
      records: 2,
      segments: 1,
      pendingSegments: 0,
    });
    expect(readFileSync(join(dir, 'archive', 'segments', files[0]!))).toEqual(bytes);
    expect(recovered.append(record(3))).toBe('recorded');
    expect(recovered.readHand(record().handKey)).toEqual([record(), record(2), record(3)]);
  });
  it('refuses a batch the catalog cannot index by name before reserving anything', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir) });
    expect(s.append(record())).toBe('recorded');
    const writer = (s as unknown as { catalog: InstanceType<typeof DatabaseSync> }).catalog;
    const pages = Number(writer.prepare('PRAGMA page_count').get()!.page_count),
      before = s.storageStats().archive!,
      files = readdirSync(join(dir, 'archive', 'segments'));
    // Fewer free pages than one batch's documented margin, as a real writer
    // connection would see them; no fake SQLite error and no trigger.
    writer.exec(`PRAGMA max_page_count=${pages + 8};`);
    // A replayed-only batch reserves nothing, so it is not refused and the
    // ring retires nothing for it.
    expect(s.appendBatch([record()])).toEqual(['replayed']);
    expect(s.storageStats().archive).toEqual({ ...before, pendingSegments: 0 });
    expect(readdirSync(join(dir, 'archive', 'segments'))).toEqual(files);
    let capacityError: unknown;
    try {
      s.appendBatch([record(2), record(3)]);
    } catch (error) {
      capacityError = error;
    }
    expect(capacityError).toMatchObject({ message: 'horse_archive_catalog_capacity' });
    expect(horseJournalCapacityReason(capacityError)).toBe('archive_catalog_capacity');
    // Nothing was reserved: no pending row, no usage charge for the batch, no
    // staged file. The ring retired the one published segment trying to make
    // room, and that retirement is kept (2026-09-26): its rows, usage and
    // file are gone together, and the hand reads it as missing.
    expect(s.storageStats().archive).toEqual({
      ...before,
      compressedBytes: 0,
      segments: 0,
      publishedSegments: 0,
      records: 0,
      retiredSegments: 1,
      retiredRecords: 1,
      pendingSegments: 0,
      maxRowid: 0,
      catalogBytes: s.storageStats().archive!.catalogBytes,
    });
    expect(readdirSync(join(dir, 'archive', 'segments'))).toEqual([]);
    expect(s.readHand(record().handKey)).toEqual([]);
    writer.exec(`PRAGMA max_page_count=${(6 * 1024 * 1024 * 1024) / 4096};`);
    expect(s.appendBatch([record(2), record(3)])).toEqual(['recorded', 'recorded']);
    expect(s.readHand(record().handKey)).toEqual([record(2), record(3)]);
  });
  it('recovers publication interrupted between hard-link creation and staging unlink', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir) }),
      native = catalog(dir);
    native.exec(
      "CREATE TRIGGER fail_index BEFORE INSERT ON archive_events BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;"
    );
    expect(() => s.append(record())).toThrow();
    const row = native.prepare('SELECT sha FROM archive_pending').get()!,
      final = join(dir, 'archive', 'segments', row.sha + '.ndjson.gz');
    // Reconstruct the precise interrupted hard-link publication state.
    linkSync(final, join(dir, 'archive', 'segments', row.sha + '.pending'));
    native.exec('DROP TRIGGER fail_index');
    native.close();
    expect(s.append(record())).toBe('replayed');
    expect(readdirSync(join(dir, 'archive', 'segments'))).toEqual([row.sha + '.ndjson.gz']);
  });
  it.each(['missing', 'changed', 'hardlink'] as const)(
    'refuses %s custody on both replay and read',
    (damage) => {
      const dir = folder(),
        s = store(dir, { archive: options(dir) });
      s.append(record());
      const path = join(
        dir,
        'archive',
        'segments',
        readdirSync(join(dir, 'archive', 'segments'))[0]!
      );
      if (damage === 'missing') rmSync(path);
      else if (damage === 'changed') writeFileSync(path, 'invalid');
      else linkSync(path, join(dir, 'extra-link'));
      expect(() => s.append(record())).toThrow();
      expect(() => s.readHand(record().handKey)).toThrow();
    }
  );
  it('refuses legacy mutation rather than pairing archive custody with a changed source', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir) });
    s.append(record());
    const other = store(dir);
    other.append(record(2));
    expect(() => s.append(record(3))).toThrow('legacy file changed');
    expect(() => s.readHand(record().handKey)).toThrow('legacy file changed');
    expect(() => store(dir, { archive: options(dir) })).toThrow('legacy identity changed');
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    'refuses invalid archive resource allocation %s',
    (n) => {
      for (const key of ['maxBytes', 'maxSegments'])
        expect(() => store(folder(), { archive: options(folder(), { [key]: n }) })).toThrow(
          'configuration'
        );
    }
  );
  it('refuses a present incomplete archive instead of silently reading legacy only', () => {
    const dir = folder(),
      s = store(dir);
    s.close();
    mkdirSync(join(dir, 'archive'), { mode: 0o700 });
    expect(() => store(dir, { readOnly: true, archive: options(dir) })).toThrow();
    expect(readdirSync(join(dir, 'archive'))).toEqual([]);
  });
  it('retains the one reserved batch before file creation and replaces only its partial staging bytes', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir) });
    const sha = journalHash(horseJournalJson(record()) + '\n');
    const stage = join(dir, 'archive', 'segments', sha + '.pending');
    mkdirSync(stage, { mode: 0o700 });
    expect(() => s.append(record())).toThrow('not private');
    expect(s.storageStats().archive).toMatchObject({ pendingSegments: 1, records: 1 });
    rmSync(stage, { recursive: true });
    writeFileSync(stage, 'interrupted', { mode: 0o600 });
    expect(s.append(record())).toBe('replayed');
    expect(s.readHand(record().handKey)).toEqual([record()]);
    expect(readdirSync(join(dir, 'archive', 'segments'))).toEqual([sha + '.ndjson.gz']);
  });
  it('reports a changed writer allocation and refuses the stale writer without losing exact replay', () => {
    const dir = folder(),
      a = store(dir, { archive: options(dir) });
    a.append(record());
    const b = store(dir, { archive: options(dir, { maxBytes: 1 }) });
    expect(() => a.append(record(2))).toThrow('writer allocation changed');
    expect(b.append(record())).toBe('replayed');
    expect(() => b.append(record(2))).toThrow('byte_capacity');
    expect(b.storageStats().archive).toMatchObject({ maxBytes: 1, records: 1 });
  });
  it.each([
    [new Error('horse_archive_byte_capacity'), 'archive_bytes'],
    [new Error('horse_archive_segment_capacity'), 'archive_segments'],
    [{ code: 'ERR_SQLITE_ERROR', errcode: 13 }, 'archive_storage_capacity'],
    [{ code: 'ENOSPC' }, 'archive_storage_capacity'],
    [new Error('private-path-or-record'), undefined],
  ])('emits only a finite capacity reason', (error, expected) => {
    expect(horseJournalCapacityReason(error)).toBe(expected);
  });
  it('preserves the combined 256-record read bound', () => {
    const dir = folder(),
      legacy = store(dir);
    legacy.append(record());
    legacy.close();
    const s = store(dir, { archive: options(dir) });
    for (let first = 2; first <= 257; first += 16)
      s.appendBatch(Array.from({ length: 16 }, (_, i) => record(first + i)));
    expect(() => s.readHand(record().handKey)).toThrow('read exceeds bounds');
  });
  it('bounds cumulative decode work independently of the selected hand bytes', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir) });
    for (let batch = 0; batch < 10; batch++) {
      const rows = [record(batch * 10 + 1)];
      for (let i = 2; i <= 8; i++)
        rows.push(
          makeHorseJournalRecord(
            {
              producerId: record().producerId,
              sequence: batch * 10 + i,
              atMs: 1000,
              sourceRelease: null,
              kind: 'decision',
              handKey: journalHash('other'),
              turnKey: record().turnKey,
            },
            { large: 'x'.repeat(490000) }
          )
        );
      s.appendBatch(rows);
    }
    expect(() => s.readHand(record().handKey)).toThrow('decode bounds');
  });
  it('the actual dedicated worker writes configured archive custody beyond a full legacy spool', async () => {
    const dir = folder(),
      legacy = store(dir, { maxRecords: 1 });
    legacy.append(record());
    legacy.close();
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const entry = new URL('./horseDecisionJournal/worker.ts', import.meta.url).href;
    const code = `import { tsImport } from ${JSON.stringify(tsx)}; await tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)});`;
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)), {
      workerData: { directory: dir, archive: options(dir) },
    });
    try {
      const next = () =>
        new Promise<any>((resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
        });
      expect(await next()).toEqual({ type: 'READY' });
      const reply = next();
      worker.postMessage({ type: 'APPEND', records: [record(2)] });
      expect(await reply).toMatchObject({
        type: 'ACK',
        receipts: [{ status: 'recorded', eventId: record(2).eventId }],
      });
      const stats = next();
      worker.postMessage({ type: 'STATS' });
      expect(await stats).toMatchObject({
        type: 'STATS',
        stats: {
          archive: {
            records: 1,
            segments: 1,
            pendingSegments: 0,
            maxRecords: 1600,
            maxRowid: 1,
            appliedMaxCatalogBytes: 6 * 1024 * 1024 * 1024,
          },
        },
      });
      const stopped = next();
      worker.postMessage({ type: 'STOP' });
      expect(await stopped).toEqual({ type: 'STOPPED' });
      const reader = store(dir, { readOnly: true, archive: options(dir) });
      expect(reader.readHand(record().handKey)).toEqual([record(), record(2)]);
    } finally {
      await worker.terminate();
    }
  });
});

describe('the capacity probe asks the writer, read-only, whether a quota has room', () => {
  const archiveOptions = (dir: string, patch = {}) => ({
    directory: join(dir, 'archive'),
    maxBytes: 1024 * 1024,
    maxSegments: 100,
    ...patch,
  });
  it('agrees with the writer at the segment and byte quotas and changes nothing', () => {
    const dir = folder(),
      s = store(dir, { archive: archiveOptions(dir, { maxSegments: 1 }) });
    expect(s.capacityRefusal([record(1)])).toBeNull();
    expect(s.appendBatch([record(1)])).toEqual(['recorded']);
    const before = s.storageStats();
    const files = readdirSync(join(dir, 'archive', 'segments'));
    // At the segment quota with a published segment to retire, the probe says
    // room, because that is what the next append will make; it retires nothing.
    expect(s.capacityRefusal([record(2)])).toBeNull();
    expect(s.storageStats()).toEqual(before);
    expect(readdirSync(join(dir, 'archive', 'segments'))).toEqual(files);
    expect(s.appendBatch([record(2)])).toEqual(['recorded']);
    expect(readdirSync(join(dir, 'archive', 'segments'))).not.toEqual(files);
    const small = folder(),
      tiny = store(small, { archive: archiveOptions(small, { maxBytes: 1 }) });
    expect(tiny.capacityRefusal([record(1)])).toBe('archive_bytes');
    expect(() => tiny.appendBatch([record(1)])).toThrow('horse_archive_byte_capacity');
    expect(() => s.capacityRefusal([])).toThrow();
  });
  it('sees catalog room return and the writer then accepts the same batch', () => {
    const dir = folder(),
      s = store(dir, { archive: archiveOptions(dir) });
    const writer = (s as unknown as { catalog: InstanceType<typeof DatabaseSync> }).catalog;
    const pages = Number(writer.prepare('PRAGMA page_count').get()!.page_count),
      empty = s.storageStats().archive!;
    // Nothing published: the catalog ceiling refuses by name and nothing changes.
    writer.exec(`PRAGMA max_page_count=${pages + 8};`);
    expect(s.capacityRefusal([record(2), record(3)])).toBe('archive_catalog_capacity');
    expect(() => s.appendBatch([record(2), record(3)])).toThrow('horse_archive_catalog_capacity');
    expect(s.storageStats().archive).toEqual({ ...empty, pendingSegments: 0 });
    writer.exec(`PRAGMA max_page_count=${(6 * 1024 * 1024 * 1024) / 4096};`);
    expect(s.append(record())).toBe('recorded');
    // With a published segment the probe says room, the append retires it and,
    // when the ceiling still refuses, keeps that retirement and refuses by
    // name: the next attempt starts nearer to room, never from the same place.
    const held = Number(writer.prepare('PRAGMA page_count').get()!.page_count);
    writer.exec(`PRAGMA max_page_count=${held + 8};`);
    expect(s.capacityRefusal([record(2), record(3)])).toBeNull();
    expect(() => s.appendBatch([record(2), record(3)])).toThrow('horse_archive_catalog_capacity');
    expect(s.storageStats().archive).toMatchObject({
      records: 0,
      segments: 0,
      pendingSegments: 0,
      retiredSegments: 1,
    });
    expect(s.capacityRefusal([record(2), record(3)])).toBe('archive_catalog_capacity');
    writer.exec(`PRAGMA max_page_count=${(6 * 1024 * 1024 * 1024) / 4096};`);
    expect(s.capacityRefusal([record(2), record(3)])).toBeNull();
    expect(s.appendBatch([record(2), record(3)])).toEqual(['recorded', 'recorded']);
    expect(s.readHand(record().handKey)).toEqual([record(2), record(3)]);
  });
  it('the actual dedicated worker answers a probe without writing', async () => {
    const dir = folder();
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const entry = new URL('./horseDecisionJournal/worker.ts', import.meta.url).href;
    const code = `import { tsImport } from ${JSON.stringify(tsx)}; await tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)});`;
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)), {
      workerData: { directory: dir, archive: archiveOptions(dir, { maxSegments: 1 }) },
    });
    try {
      const next = () =>
        new Promise<any>((resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
        });
      const ask = (message: unknown) => {
        const reply = next();
        worker.postMessage(message);
        return reply;
      };
      expect(await next()).toEqual({ type: 'READY' });
      expect(await ask({ type: 'PROBE', records: [record(1)] })).toEqual({
        type: 'CAPACITY',
        room: true,
      });
      expect(await ask({ type: 'APPEND', records: [record(1)] })).toMatchObject({ type: 'ACK' });
      // At the quota the probe answers room and the append retires the oldest
      // published segment: capture continues through the real writer.
      expect(await ask({ type: 'PROBE', records: [record(2)] })).toEqual({
        type: 'CAPACITY',
        room: true,
      });
      expect(await ask({ type: 'APPEND', records: [record(2)] })).toMatchObject({
        type: 'ACK',
        receipts: [{ eventId: record(2).eventId, status: 'recorded' }],
      });
      // A malformed probe is answered "no room", never a failure of the writer.
      expect(await ask({ type: 'PROBE', records: [{ bogus: true }] })).toEqual({
        type: 'CAPACITY',
        room: false,
      });
      const stats = await ask({ type: 'STATS' });
      expect(stats.stats.archive).toMatchObject({
        records: 1,
        segments: 1,
        pendingSegments: 0,
        publishedSegments: 1,
        retiredSegments: 1,
      });
      expect(await ask({ type: 'STOP' })).toEqual({ type: 'STOPPED' });
    } finally {
      await worker.terminate();
    }
  });
});

describe('the archive is a ring: the oldest published segments make room, unpublished ones never do', () => {
  const options = (dir: string, patch = {}) => ({
    directory: join(dir, 'archive'),
    maxBytes: 1024 * 1024,
    maxSegments: 100,
    ...patch,
  });
  const catalog = (dir: string) =>
    new DatabaseSync(join(dir, 'archive', 'horse-journal-archive.sqlite'));
  const segmentFiles = (dir: string) => readdirSync(join(dir, 'archive', 'segments')).sort();
  it('retires oldest first and only as many as the batch needs; the file, the rows and the usage leave together', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir, { maxSegments: 3 }) });
    const three: string[] = [];
    for (const n of [1, 2, 3]) {
      expect(s.append(record(n))).toBe('recorded');
      three.push(segmentFiles(dir).find((f) => !three.includes(f))!);
    }
    expect(s.append(record(4))).toBe('recorded');
    expect(s.readHand(record().handKey)).toEqual([record(2), record(3), record(4)]);
    expect(s.appendBatch([record(5), record(6)])).toEqual(['recorded', 'recorded']);
    expect(s.readHand(record().handKey)).toEqual([record(3), record(4), record(5), record(6)]);
    expect(s.storageStats().archive).toMatchObject({
      segments: 3,
      publishedSegments: 3,
      pendingSegments: 0,
      records: 4,
      retiredSegments: 2,
      retiredRecords: 2,
    });
    const now = segmentFiles(dir);
    expect(now).toHaveLength(3);
    expect(now).not.toContain(three[0]);
    expect(now).not.toContain(three[1]);
    expect(now).toContain(three[2]);
    const native = catalog(dir);
    expect(native.prepare('SELECT count(*) AS n FROM archive_retired').get()!.n).toBe(0);
    expect(native.prepare('SELECT count(*) AS n FROM archive_segments').get()!.n).toBe(3);
    expect(native.prepare('SELECT count(*) AS n FROM archive_events').get()!.n).toBe(4);
    const usage = native.prepare('SELECT bytes FROM archive_meta WHERE id=1').get()!;
    expect(usage.bytes).toBe(
      native.prepare('SELECT sum(bytes) AS n FROM archive_segments').get()!.n
    );
    native.close();
  });
  it('the byte quota is the same ring: the oldest published segment goes when a new one needs its bytes', () => {
    const sizing = folder(),
      probe = store(sizing, { archive: options(sizing) });
    probe.append(record(1));
    probe.append(record(2));
    const maxBytes = probe.storageStats().archive!.compressedBytes;
    probe.close();
    const dir = folder(),
      s = store(dir, { archive: options(dir, { maxBytes }) });
    expect(s.append(record(1))).toBe('recorded');
    expect(s.append(record(2))).toBe('recorded');
    expect(s.append(record(3, { a: 1 }))).toBe('recorded');
    expect(s.readHand(record().handKey)).toEqual([record(2), record(3, { a: 1 })]);
    expect(s.storageStats().archive).toMatchObject({ segments: 2, retiredSegments: 1 });
    expect(s.storageStats().archive!.compressedBytes).toBeLessThanOrEqual(maxBytes);
  });
  it('never retires a reserved batch that was not published; only unpublished segments hold the quota', () => {
    const dir = folder(),
      s = store(dir, { archive: options(dir, { maxSegments: 1 }) }),
      native = catalog(dir);
    native.exec(
      "CREATE TRIGGER fail_index BEFORE INSERT ON archive_events BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;"
    );
    expect(() => s.append(record(1))).toThrow('synthetic interruption');
    expect(s.storageStats().archive).toMatchObject({
      segments: 1,
      publishedSegments: 0,
      pendingSegments: 1,
      retiredSegments: 0,
    });
    // The probe: nothing published can be retired, so the quota stands by name.
    expect(s.capacityRefusal([record(2)])).toBe('archive_segments');
    // The append: the reserved batch is completed first, never retired, and
    // while it cannot be completed nothing is retired either.
    expect(() => s.append(record(2))).toThrow('synthetic interruption');
    expect(s.storageStats().archive).toMatchObject({
      segments: 1,
      pendingSegments: 1,
      retiredSegments: 0,
    });
    expect(native.prepare('SELECT count(*) AS n FROM archive_pending').get()!.n).toBe(1);
    native.exec('DROP TRIGGER fail_index');
    native.close();
    // Once published it is the oldest published segment, and the ring may retire it.
    expect(s.append(record(2))).toBe('recorded');
    expect(s.readHand(record().handKey)).toEqual([record(2)]);
    expect(s.storageStats().archive).toMatchObject({
      segments: 1,
      publishedSegments: 1,
      pendingSegments: 0,
      retiredSegments: 1,
    });
  });
  it('a lowered ring retires its excess over the following appends and keeps the newest', () => {
    const dir = folder(),
      a = store(dir, { archive: options(dir, { maxSegments: 5 }) });
    for (const n of [1, 2, 3, 4, 5]) a.append(record(n));
    a.close();
    const b = store(dir, { archive: options(dir, { maxSegments: 2 }) });
    expect(b.append(record(6))).toBe('recorded');
    expect(b.readHand(record().handKey)).toEqual([record(5), record(6)]);
    expect(b.storageStats().archive).toMatchObject({
      segments: 2,
      maxSegments: 2,
      retiredSegments: 4,
    });
    expect(segmentFiles(dir)).toHaveLength(2);
  });
  it('a file whose rows were retired before the process died is unlinked at the next open', () => {
    const dir = folder(),
      a = store(dir, { archive: options(dir) });
    a.append(record(1));
    a.close();
    const sha = 'f'.repeat(64),
      orphan = join(dir, 'archive', 'segments', sha + '.ndjson.gz');
    writeFileSync(orphan, gzipSync(Buffer.from('retired\n')), { mode: 0o600 });
    const native = catalog(dir);
    native.prepare('INSERT INTO archive_retired VALUES(?,?)').run(sha, 1);
    native.close();
    const b = store(dir, { archive: options(dir) });
    expect(segmentFiles(dir)).not.toContain(sha + '.ndjson.gz');
    expect(catalog(dir).prepare('SELECT count(*) AS n FROM archive_retired').get()!.n).toBe(0);
    expect(b.readHand(record().handKey)).toEqual([record(1)]);
  });
  it('a segment retired between a reader snapshot and its file read is missing, not corruption', () => {
    const dir = folder(),
      w = store(dir, { archive: options(dir, { maxSegments: 1 }) });
    w.append(record(1));
    const r = store(dir, { readOnly: true, archive: options(dir) });
    const proto = HorseDecisionJournalStore.prototype as unknown as {
      readSegment: (row: unknown) => unknown;
    };
    const original = proto.readSegment;
    const spy = vi.spyOn(proto, 'readSegment').mockImplementationOnce(function (
      this: unknown,
      row: unknown
    ) {
      // The writer retires the snapshotted segment before the reader opens it.
      spy.mockRestore();
      w.append(record(2));
      return original.call(this, row);
    });
    expect(r.readHand(record().handKey)).toEqual([]);
    expect(r.readHand(record().handKey)).toEqual([record(2)]);
  });
  it('a read-only observer of a catalog that has not been opened by a ring writer reports zero retired', () => {
    const dir = folder(),
      a = store(dir, { archive: options(dir) });
    a.append(record(1));
    a.close();
    const native = catalog(dir);
    native.exec('DROP TABLE archive_ring; DROP TABLE archive_retired;');
    native.close();
    const r = store(dir, { readOnly: true, archive: options(dir) });
    expect(r.storageStats().archive).toMatchObject({
      publishedSegments: 1,
      retiredSegments: 0,
      retiredRecords: 0,
    });
  });
  it('/health says whether capture runs and why, with the ring counts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const w = new FakeWorker(),
        p = new HorseDecisionJournalPublisher(w, () => {}, { wallNow: () => PAUSED_AT });
      w.emit({ type: 'READY' });
      p.health();
      w.emit({ type: 'STATS', stats: { archive: STATS_ARCHIVE } });
      expect(p.health()).toMatchObject({
        segments: 1,
        maxSegments: 100,
        publishedSegments: 1,
        pendingSegments: 0,
        retiredSegments: 4,
        retiredRecords: 12,
        compressedBytes: 10,
        maxBytes: 1024,
        capture:
          'running: the archive is a ring of 100 segments; the oldest published segment is retired when a new one needs its room; retained=1 published=1 unpublished=0 retired=4',
      });
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'UNAVAILABLE', reason: 'archive_segments' });
      expect(p.health().capture).toBe(
        'not running: paused since 2026-09-25T19:34:05.000Z at archive_segments with no published segment left to retire (only unpublished segments remain); asks again every minute; retained=1 published=1 unpublished=0 retired=4'
      );
      w.emit({ type: 'CAPACITY', room: false, reason: 'archive_storage_capacity' });
      expect(p.health().capture).toBe(
        'not running: paused since 2026-09-25T19:34:05.000Z because the filesystem is out of room; the ring retires only within its own allocation and asks again every minute; retained=1 published=1 unpublished=0 retired=4'
      );
      void p.stop();
    } finally {
      warn.mockRestore();
    }
  });
});

const CAPACITY_REASONS = [
  'archive_bytes',
  'archive_segments',
  'archive_catalog_capacity',
  'archive_storage_capacity',
] as const;
const PAUSED_AT = Date.parse('2026-09-25T19:34:05.000Z');
const identities = (records: readonly HorseJournalRecord[]) =>
  records.map((r) => [r.eventId, r.sha256]);
const sentOf = (w: FakeWorker, type: string) =>
  w.sent.filter((m) => m.type === type) as Array<{ type: string; records: HorseJournalRecord[] }>;
const STATS_ARCHIVE = {
  compressedBytes: 10,
  segments: 1,
  records: 3,
  pendingSegments: 0,
  publishedSegments: 1,
  retiredSegments: 4,
  retiredRecords: 12,
  catalogBytes: 40960,
  maxRowid: 3,
  maxBytes: 1024,
  maxSegments: 100,
  maxRecords: 1600,
  maxCatalogBytes: 6 * 1024 * 1024 * 1024,
  appliedMaxCatalogBytes: 6 * 1024 * 1024 * 1024,
};

describe('capacity is a condition: the journal pauses at its quota and says so', () => {
  it.each(CAPACITY_REASONS)(
    'pauses on %s, keeps its queue, re-probes and replays the same records once when room returns',
    async (reason) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const w = new FakeWorker(),
          notes: string[] = [],
          p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x), {
            wallNow: () => PAUSED_AT,
          });
        p.record('decision', 'hand', 'turn', { n: 1 });
        w.emit({ type: 'READY' });
        const head = sentOf(w, 'APPEND')[0]!.records;
        w.emit({ type: 'UNAVAILABLE', reason });
        expect(p.health()).toMatchObject({
          mode: 'paused',
          pausedReason: reason,
          pausedSince: '2026-09-25T19:34:05.000Z',
          lastFailureReason: null,
          failedSince: null,
          queued: 1,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          `[HorseDecisionJournal] capture paused mode=paused reason=${reason} queued=1`
        );
        // The writer is kept: a quota is not a broken writer.
        expect(w.terminate).not.toHaveBeenCalled();
        expect(notes).toContain('phase15_journal_' + reason);
        expect(notes).toContain('phase15_journal_capacity_paused');
        expect(notes).not.toContain('phase15_journal_unavailable');
        // record() while paused is counted as paused, not as a failed journal,
        // and still queues within the same bounds.
        p.record('execution', 'hand', 'turn', { n: 2 });
        expect(notes).toContain('phase15_journal_capture_paused_capacity');
        expect(notes).not.toContain('phase15_journal_capture_unavailable');
        expect(p.health().queued).toBe(2);
        expect(sentOf(w, 'APPEND')).toHaveLength(1);
        // A fixed, bounded schedule: nothing before a minute, then one a minute.
        await vi.advanceTimersByTimeAsync(59_999);
        expect(sentOf(w, 'PROBE')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(sentOf(w, 'PROBE')).toHaveLength(1);
        const probed = sentOf(w, 'PROBE')[0]!.records;
        expect(probed).toHaveLength(2);
        expect(identities(probed.slice(0, 1))).toEqual(identities(head));
        w.emit({ type: 'CAPACITY', room: false, reason });
        expect(p.health()).toMatchObject({ mode: 'paused', pausedReason: reason });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sentOf(w, 'PROBE')).toHaveLength(2);
        expect(sentOf(w, 'APPEND')).toHaveLength(1);
        // A probe is not a retry: the restart budget is untouched.
        expect(notes).not.toContain('phase15_journal_retry_scheduled');
        // Room again (a quota raised for the next start, or a rotated archive).
        w.emit({ type: 'CAPACITY', room: true });
        expect(p.health()).toMatchObject({
          mode: 'ready',
          pausedReason: null,
          pausedSince: null,
          lastFailureReason: null,
        });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenLastCalledWith(
          `[HorseDecisionJournal] capture resumed mode=ready after=${reason} queued=2`
        );
        expect(notes).toContain('phase15_journal_capacity_resumed');
        const replay = sentOf(w, 'APPEND')[1]!.records;
        expect(identities(replay)).toEqual(identities(probed));
        expect(replay[0]).toEqual(head[0]);
        w.emit({
          type: 'ACK',
          receipts: replay.map((r) => ({
            eventId: r.eventId,
            sha256: r.sha256,
            status: 'recorded',
          })),
        });
        expect(p.health()).toMatchObject({ mode: 'ready', queued: 0 });
        expect(notes.filter((x) => x === 'phase15_journal_recorded')).toHaveLength(2);
        // Resumed: no more probes and no second copy of anything.
        await vi.advanceTimersByTimeAsync(180_000);
        expect(sentOf(w, 'PROBE')).toHaveLength(2);
        expect(sentOf(w, 'APPEND')).toHaveLength(2);
        const stopping = p.stop();
        expect(w.sent.at(-1)).toEqual({ type: 'STOP' });
        w.emit({ type: 'STOPPED' });
        await stopping;
        expect(p.health().mode).toBe('stopped');
      } finally {
        warn.mockRestore();
      }
    }
  );
  it('keeps the bounded queue while paused and drops beyond it with the same count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const w = new FakeWorker(),
        notes: string[] = [],
        p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x));
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'READY' });
      w.emit({ type: 'UNAVAILABLE', reason: 'archive_segments' });
      for (let i = 0; i < 70; i++) p.record('decision', 'hand', 'turn', { i });
      expect(p.health().queued).toBe(64);
      expect(notes.filter((x) => x === 'phase15_journal_queue_capacity')).toHaveLength(7);
      expect(notes.filter((x) => x === 'phase15_journal_capture_paused_capacity')).toHaveLength(70);
      // Stopping while paused is prompt and names the gap it leaves.
      const stopping = p.stop();
      expect(w.sent.at(-1)).toEqual({ type: 'STOP' });
      w.emit({ type: 'STOPPED' });
      await stopping;
      expect(p.health().mode).toBe('stopped');
      expect(notes).toContain('phase15_journal_shutdown_unverified');
      expect(notes).not.toContain('phase15_journal_recorded');
    } finally {
      warn.mockRestore();
    }
  });
  it('a quota refusal while draining for shutdown stops at once and names the gap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const w = new FakeWorker(),
        notes: string[] = [],
        p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x));
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'READY' });
      const stopping = p.stop();
      w.emit({ type: 'UNAVAILABLE', reason: 'archive_segments' });
      expect(w.sent.at(-1)).toEqual({ type: 'STOP' });
      w.emit({ type: 'STOPPED' });
      await stopping;
      expect(p.health().mode).toBe('stopped');
      expect(notes).toContain('phase15_journal_shutdown_unverified');
      expect(sentOf(w, 'PROBE')).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
  it('an integrity refusal stays terminal: ack_mismatch fails, never pauses, never probes', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const w = new FakeWorker(),
        notes: string[] = [],
        p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x), {
          wallNow: () => PAUSED_AT,
        });
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'READY' });
      p.health();
      w.emit({ type: 'STATS', stats: { archive: STATS_ARCHIVE } });
      const head = sentOf(w, 'APPEND')[0]!.records[0]!;
      w.emit({
        type: 'ACK',
        receipts: [{ eventId: 'wrong', sha256: head.sha256, status: 'recorded' }],
      });
      expect(warn).toHaveBeenCalledWith(
        '[HorseDecisionJournal] capture stopped mode=failed reason=ack_mismatch'
      );
      // /health says failed, with the reason, when, and the last stats it had.
      expect(p.health()).toMatchObject({
        mode: 'failed',
        lastFailureReason: 'ack_mismatch',
        failedSince: '2026-09-25T19:34:05.000Z',
        pausedReason: null,
        pausedSince: null,
        queued: 1,
        records: 3,
        catalogBytes: 40960,
        maxRecords: 1600,
      });
      p.record('decision', 'hand', 'turn2', {});
      expect(notes).toContain('phase15_journal_capture_unavailable');
      expect(notes).not.toContain('phase15_journal_capture_paused_capacity');
      await vi.advanceTimersByTimeAsync(180_000);
      expect(sentOf(w, 'PROBE')).toHaveLength(0);
      expect(w.terminate).toHaveBeenCalledOnce();
      // A late capacity answer cannot revive a failed journal.
      w.emit({ type: 'CAPACITY', room: true });
      expect(p.health().mode).toBe('failed');
      await p.stop();
    } finally {
      warn.mockRestore();
    }
  });
  it('a capacity report from a writer that never became ready stays terminal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const w = new FakeWorker(),
        notes: string[] = [],
        p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x));
      p.record('decision', 'hand', 'turn', {});
      // The writer could not open (it closes its port after this message).
      w.emit({ type: 'UNAVAILABLE', reason: 'archive_storage_capacity' });
      expect(p.health()).toMatchObject({
        mode: 'failed',
        lastFailureReason: 'archive_storage_capacity',
      });
      await p.stop();
    } finally {
      warn.mockRestore();
    }
  });
  it('shows paused with its reason and keeps the last stats while paused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let clock = 0;
      const w = new FakeWorker(),
        p = new HorseDecisionJournalPublisher(w, () => {}, {
          now: () => clock,
          wallNow: () => PAUSED_AT,
        });
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'READY' });
      p.health();
      w.emit({ type: 'STATS', stats: { archive: STATS_ARCHIVE } });
      clock = 100;
      w.emit({ type: 'UNAVAILABLE', reason: 'archive_segments' });
      clock = 5000;
      expect(p.health()).toMatchObject({
        mode: 'paused',
        pausedReason: 'archive_segments',
        pausedSince: '2026-09-25T19:34:05.000Z',
        lastFailureReason: null,
        failedSince: null,
        queued: 1,
        records: 3,
        maxRecords: 1600,
        catalogBytes: 40960,
        statsAgeMs: 5000,
      });
      // A paused writer is alive, so it is still asked for fresh figures.
      expect(sentOf(w, 'STATS')).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('/health reads the journal from the thread that runs it', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it('says disabled without a directory, starting before any report, then the owning report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.stubEnv('HORSE_DECISION_JOURNAL_DIR', '');
      expect(horseDecisionJournalHealth()).toMatchObject({ mode: 'disabled' });
      vi.stubEnv('HORSE_DECISION_JOURNAL_DIR', '/unused-fixture-horse-journal');
      // This thread owns no publisher and nothing has reported yet.
      expect(horseDecisionJournalHealth()).toMatchObject({
        mode: 'starting',
        lastFailureReason: null,
        reportAgeMs: null,
      });
      // The publisher that failed lives in the Horse decision worker.
      const w = new FakeWorker(),
        p = new HorseDecisionJournalPublisher(w, () => {}, { wallNow: () => PAUSED_AT });
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'READY' });
      p.health();
      w.emit({ type: 'STATS', stats: { archive: STATS_ARCHIVE } });
      w.emit({ type: 'ACK', receipts: [] });
      relayHorseDecisionJournalHealth(JSON.parse(JSON.stringify(p.health())));
      const relayed = horseDecisionJournalHealth()!;
      expect(relayed).toMatchObject({
        mode: 'failed',
        lastFailureReason: 'ack_mismatch',
        failedSince: '2026-09-25T19:34:05.000Z',
        queued: 1,
        records: 3,
        maxRecords: 1600,
      });
      expect(typeof relayed.reportAgeMs).toBe('number');
      // A malformed report is ignored rather than shown.
      relayHorseDecisionJournalHealth({ mode: 'fine', path: '/unused-fixture-horse-journal' });
      relayHorseDecisionJournalHealth(null);
      expect(horseDecisionJournalHealth()!.mode).toBe('failed');
      // Only the finite field set crosses; free text never does.
      relayHorseDecisionJournalHealth({
        ...p.health(),
        path: '/unused-fixture-horse-journal',
        lastFailureReason: 'ENOSPC /unused-fixture-horse-journal',
      });
      expect(horseDecisionJournalHealth()).not.toHaveProperty('path');
      expect(horseDecisionJournalHealth()!.lastFailureReason).toBeNull();
      // The capture sentence is rebuilt on this thread from the finite fields,
      // never copied from the report.
      relayHorseDecisionJournalHealth({ ...p.health(), capture: 'running: /unused-fixture-path' });
      expect(horseDecisionJournalHealth()!.capture).toBe(p.health().capture);
      expect(horseDecisionJournalHealth()!.capture).toMatch(
        /^not running: capture stopped for good at ack_mismatch/
      );
      await p.stop();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the journal says why it stopped and shows itself to /health', () => {
  it('names the publisher fence that gave up when the writer never said', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const w = new FakeWorker(),
        p = new HorseDecisionJournalPublisher(w, () => {});
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'READY' });
      const head = (w.sent[0] as { records: HorseJournalRecord[] }).records[0]!;
      w.emit({
        type: 'ACK',
        receipts: [{ eventId: 'wrong', sha256: head.sha256, status: 'recorded' }],
      });
      expect(warn).toHaveBeenCalledWith(
        '[HorseDecisionJournal] capture stopped mode=failed reason=ack_mismatch'
      );
      expect(p.health().lastFailureReason).toBe('ack_mismatch');
      await p.stop();
    } finally {
      warn.mockRestore();
    }
  });
  it('answers health from its cache and asks a ready writer at most once a second', () => {
    let clock = 0;
    const w = new FakeWorker(),
      p = new HorseDecisionJournalPublisher(w, () => {}, { now: () => clock });
    expect(p.health()).toEqual({
      mode: 'starting',
      lastFailureReason: null,
      pausedReason: null,
      pausedSince: null,
      failedSince: null,
      queued: 0,
      appliedMaxCatalogBytes: null,
      maxCatalogBytes: null,
      catalogBytes: null,
      segments: null,
      maxSegments: null,
      publishedSegments: null,
      pendingSegments: null,
      retiredSegments: null,
      retiredRecords: null,
      compressedBytes: null,
      maxBytes: null,
      records: null,
      maxRecords: null,
      maxRowid: null,
      statsAgeMs: null,
      reportAgeMs: null,
      capture: 'not running yet: the writer has not said READY',
    });
    // A writer that is not ready is not asked.
    expect(w.sent).toEqual([]);
    w.emit({ type: 'READY' });
    expect(p.health().mode).toBe('ready');
    expect(w.sent).toEqual([{ type: 'STATS' }]);
    // Unanswered: the probe does not wait and does not ask again yet.
    clock = 500;
    p.health();
    expect(w.sent).toHaveLength(1);
    const archive = {
      compressedBytes: 10,
      segments: 1,
      records: 3,
      pendingSegments: 0,
      catalogBytes: 40960,
      maxRowid: 3,
      maxBytes: 1024,
      maxSegments: 100,
      maxRecords: 1600,
      maxCatalogBytes: 6 * 1024 * 1024 * 1024,
      appliedMaxCatalogBytes: 6 * 1024 * 1024 * 1024,
    };
    w.emit({ type: 'STATS', stats: { legacy: {}, archive } });
    clock = 700;
    expect(p.health()).toMatchObject({
      mode: 'ready',
      appliedMaxCatalogBytes: 6 * 1024 * 1024 * 1024,
      maxCatalogBytes: 6 * 1024 * 1024 * 1024,
      catalogBytes: 40960,
      pendingSegments: 0,
      records: 3,
      maxRecords: 1600,
      maxRowid: 3,
      statsAgeMs: 200,
    });
    // The reply released the throttle, so the next probe asks again.
    expect(w.sent).toEqual([{ type: 'STATS' }, { type: 'STATS' }]);
    // A stats reply is never an acknowledgement and never a failure: the
    // in-flight batch stays queued until its own exact ACK, and a malformed
    // reply is ignored rather than treated as a broken ACK.
    p.record('decision', 'hand', 'turn', {});
    const batch = w.sent[2] as { records: HorseJournalRecord[] };
    w.emit({ type: 'STATS', stats: null });
    w.emit({ type: 'STATS', stats: { archive: { records: 'many' } } });
    expect(p.health()).toMatchObject({ mode: 'ready', queued: 1, records: null });
    w.emit({
      type: 'ACK',
      receipts: [
        {
          eventId: batch.records[0]!.eventId,
          sha256: batch.records[0]!.sha256,
          status: 'recorded',
        },
      ],
    });
    expect(p.health()).toMatchObject({ mode: 'ready', queued: 0 });
  });
});

describe('a writer that never said READY never started', () => {
  it('a real worker whose module cannot load is start_failed and unavailable, never ready', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // `new Worker()` does not throw for a module that fails to load: it
      // reports an 'error' then an 'exit' event after the constructor returned.
      const broken = () =>
        new Worker(
          new URL(
            'data:text/javascript,' +
              encodeURIComponent('throw new Error("horse journal writer failed to load")')
          )
        );
      const notes: string[] = [],
        startFailed = vi.fn(),
        restart = vi.fn(broken),
        p = new HorseDecisionJournalPublisher(broken(), (x) => notes.push(x), {
          restart,
          onStartFailed: startFailed,
        });
      p.record('decision', 'hand', 'turn', {});
      const deadline = Date.now() + 8000;
      const seen = new Set<string>();
      while (Date.now() < deadline && p.health().mode !== 'unavailable') {
        seen.add(p.health().mode);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(seen.has('ready')).toBe(false);
      expect(p.health()).toMatchObject({
        mode: 'unavailable',
        lastFailureReason: 'start_failed',
        queued: 1,
      });
      // The bounded replacements were still tried: a lock at open is transient.
      expect(restart).toHaveBeenCalledTimes(2);
      expect(startFailed).toHaveBeenCalledOnce();
      expect(notes).toContain('phase15_journal_start_failed');
      expect(notes).not.toContain('phase15_journal_retry_exhausted');
      expect(warn).toHaveBeenCalledWith(
        '[HorseDecisionJournal] capture stopped mode=unavailable reason=start_failed'
      );
      await p.stop();
    } finally {
      warn.mockRestore();
    }
  }, 15_000);
  it('a writer that was once ready and then keeps dying is still retry_exhausted', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = new FakeWorker(),
        b = new FakeWorker(),
        c = new FakeWorker(),
        writers = [b, c],
        startFailed = vi.fn(),
        p = new HorseDecisionJournalPublisher(a, () => {}, {
          restart: () => writers.shift()!,
          now: () => Date.now(),
          onStartFailed: startFailed,
        });
      p.record('decision', 'hand', 'turn', {});
      a.emit({ type: 'READY' });
      for (const w of [a, b, c]) {
        w.listeners.get('error')?.(new Error('died'));
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(p.health()).toMatchObject({ mode: 'failed', lastFailureReason: 'retry_exhausted' });
      expect(startFailed).not.toHaveBeenCalled();
      await p.stop();
    } finally {
      warn.mockRestore();
    }
  });
  it('a writer that dies before READY with no restart available is start_failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = new FakeWorker(),
        p = new HorseDecisionJournalPublisher(a, () => {});
      a.listeners.get('exit')?.(1);
      expect(p.health()).toMatchObject({
        mode: 'unavailable',
        lastFailureReason: 'start_failed',
      });
      await p.stop();
    } finally {
      warn.mockRestore();
    }
  });
});
