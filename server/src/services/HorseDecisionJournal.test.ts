import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, chmodSync, rmSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite');
import { HorseDecisionJournalStore } from './horseDecisionJournal/store.js';
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
const store = (dir: string, limits?: { maxBytes?: number; maxRecords?: number }) => {
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
    const script = `import { HorseDecisionJournalStore } from ${JSON.stringify(module)};const s=new HorseDecisionJournalStore(process.argv[1]);s.append(JSON.parse(process.argv[2]));process.exit(0);`;
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
