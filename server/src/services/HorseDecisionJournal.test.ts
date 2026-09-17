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
import { HorseDecisionJournalPublisher, type HorseJournalWorker } from './HorseDecisionJournal.js';

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
    } catch {}
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
  it.each(['maxBytes', 'maxSegments'] as const)(
    'reserves %s atomically and never deletes earlier custody',
    (key) => {
      const dir = folder(),
        s = store(dir, { archive: options(dir, { [key]: key === 'maxBytes' ? 1 : 1 }) });
      if (key === 'maxSegments') s.append(record());
      expect(() => s.append(record(2))).toThrow(
        key === 'maxBytes' ? 'byte_capacity' : 'segment_capacity'
      );
      expect(s.storageStats().archive).toMatchObject({
        records: key === 'maxBytes' ? 0 : 1,
        pendingSegments: 0,
      });
    }
  );
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

describe('archive capacity reporting uses the existing terminal failure path', () => {
  it.each(['archive_bytes', 'archive_segments', 'archive_storage_capacity'])(
    'reports %s without acknowledging uncaptured records',
    async (reason) => {
      const w = new FakeWorker(),
        notes: string[] = [],
        p = new HorseDecisionJournalPublisher(w, (x) => notes.push(x));
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'READY' });
      w.emit({ type: 'UNAVAILABLE', reason });
      p.record('decision', 'hand', 'turn2', {});
      await p.stop();
      expect(notes).toContain('phase15_journal_' + reason);
      expect(notes).not.toContain('phase15_journal_recorded');
      expect(notes).toContain('phase15_journal_capture_unavailable');
      expect(w.terminate).toHaveBeenCalledTimes(1);
    }
  );
});
