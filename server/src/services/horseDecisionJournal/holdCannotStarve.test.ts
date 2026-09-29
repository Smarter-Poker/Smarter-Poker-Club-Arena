/* THE JOURNAL CANNOT STOP FOR GOOD BECAUSE ITS ARCHIVE IS FULL (2026-09-28).
   On 41b91390 the archive reached its 8 GiB byte bound at 01:03:30 UTC and
   both decision-shard publishers stopped for good within seventeen minutes
   (retry_exhausted at 01:04:07, termination_unverified at 01:20:19): every
   retirement made SQLite scan the whole events table for foreign-key child
   rows, so every append at the bound held the shared catalog for seconds.
   These tests pin the three halves of the fix: a retirement never scans the
   catalog, the evidence hold can never take the ring's room, and a publisher
   stopped at a fence re-arms itself with a fresh writer. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite');
import * as storeModule from './store.js';
import { HorseDecisionJournalStore } from './store.js';
import { journalHash, makeHorseJournalRecord, type HorseJournalRecord } from './record.js';
import { horseJournalHoldBudget, type HorseJournalArchiveOptions } from './config.js';
import * as journal from '../HorseDecisionJournal.js';
import { HorseDecisionJournalPublisher, type HorseJournalWorker } from '../HorseDecisionJournal.js';

const folders: string[] = [],
  stores: HorseDecisionJournalStore[] = [];
const folder = () => {
  const p = mkdtempSync(join(tmpdir(), 'horse-journal-hold-'));
  folders.push(p);
  return p;
};
const open = (dir: string, archive: Partial<HorseJournalArchiveOptions> = {}) => {
  const s = new HorseDecisionJournalStore(dir, {
    archive: {
      directory: join(dir, 'archive'),
      maxBytes: 1024 * 1024 * 1024,
      maxSegments: 1_000_000,
      ...archive,
    },
  });
  stores.push(s);
  return s;
};
const at = (
  sequence: number,
  atMs: number,
  payload: unknown = { card: 'As' }
): HorseJournalRecord =>
  makeHorseJournalRecord(
    {
      producerId: '10000000-0000-4000-8000-000000000001',
      sequence,
      atMs,
      sourceRelease: null,
      kind: 'decision',
      handKey: journalHash('hand'),
      turnKey: journalHash('turn'),
    },
    payload
  );
const catalogPath = (dir: string) => join(dir, 'archive', 'horse-journal-archive.sqlite');
afterEach(() => {
  for (const s of stores.splice(0))
    try {
      s.close();
    } catch {
      /* closed by the test */
    }
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('a retirement never scans the catalog', () => {
  it('every ring statement is a rowid or key search under the writer connection options', () => {
    const dir = folder();
    open(dir).append(at(1, 100));
    const { HORSE_ARCHIVE_CATALOG_CONNECTION, RING_STATEMENTS } = storeModule as unknown as {
      HORSE_ARCHIVE_CATALOG_CONNECTION?: { enableForeignKeyConstraints: boolean };
      RING_STATEMENTS?: readonly string[];
    };
    // The writer's own options, not an assumption about them.
    expect(HORSE_ARCHIVE_CATALOG_CONNECTION).toBeDefined();
    expect(RING_STATEMENTS).toContain('DELETE FROM archive_segments WHERE sha=?');
    const native = new DatabaseSync(catalogPath(dir), {
      ...HORSE_ARCHIVE_CATALOG_CONNECTION,
      readOnly: true,
    });
    try {
      for (const sql of RING_STATEMENTS!) {
        const plan = native
          .prepare('EXPLAIN QUERY PLAN ' + sql)
          .all()
          .map((r) => String(r.detail));
        expect(
          plan.filter((d) => /^SCAN /.test(d)),
          sql
        ).toEqual([]);
      }
    } finally {
      native.close();
    }
  });
  it('at the byte bound on a catalog of 600,000 indexed records, one append retires 48 segments well inside the five-second fence', () => {
    const dir = folder();
    const w = open(dir);
    // 64 small segments first: the oldest, and the ring's first candidates.
    for (let n = 1; n <= 64; n++) expect(w.append(at(n, n))).toBe('recorded');
    w.close();
    // A large catalog after them: one newest filler segment whose index rows
    // stand in for the production catalog's millions of records.
    const FILLER = 600_000;
    const native = new DatabaseSync(catalogPath(dir));
    const sha = 'f'.repeat(64);
    native.exec('BEGIN');
    native
      .prepare('INSERT INTO archive_segments VALUES(?,?,?,?,?)')
      .run(sha, 'e'.repeat(64), 1, 1, 16);
    native
      .prepare(
        "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO archive_events SELECT printf('%064x',n),'filler',n,printf('%064x',n%9973),printf('%064x',n),1,?,0 FROM c"
      )
      .run(FILLER, sha);
    native
      .prepare(
        'UPDATE archive_meta SET bytes=bytes+1,segments=segments+1,records=records+? WHERE id=1'
      )
      .run(FILLER);
    native.exec('COMMIT');
    const usage = native.prepare('SELECT bytes FROM archive_meta WHERE id=1').get()!;
    const oldest48 = Number(
      native
        .prepare(
          'SELECT sum(bytes) AS n FROM (SELECT bytes FROM archive_segments ORDER BY rowid LIMIT 48)'
        )
        .get()!.n
    );
    native.close();
    // Full to the byte less the 48 oldest segments: the next append must
    // retire at least 48 of them.
    const s = open(dir, { maxBytes: Number(usage.bytes) - oldest48 + 1 });
    const started = performance.now();
    expect(s.append(at(1_000, 1_000))).toBe('recorded');
    const elapsed = performance.now() - started;
    expect(s.storageStats().archive!.retiredSegments).toBeGreaterThanOrEqual(48);
    // With foreign-key enforcement each of those 48 retirements scanned all
    // 600,000 rows (seconds in all); without it they are rowid searches.
    expect(elapsed).toBeLessThan(1_000);
  }, 60_000);
});

describe('the evidence hold has its own budget and cannot take the ring’s room', () => {
  /** Ten segments at t=100..1000, then the archive is full to the byte. */
  const fullArchive = (dir: string) => {
    const w = open(dir);
    for (let n = 1; n <= 10; n++) expect(w.append(at(n, n * 100))).toBe('recorded');
    const bytes = w.storageStats().archive!.compressedBytes;
    w.close();
    return bytes;
  };
  it('archive at maxBytes with a hold over everything: capture keeps running, the oldest held segments stay', () => {
    const dir = folder();
    const maxBytes = fullArchive(dir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = open(dir, { maxBytes, hold: { fromMs: 1, untilMs: 100_000 } });
      const stats = s.storageStats().archive!;
      const budget = horseJournalHoldBudget(maxBytes, 1_000_000);
      expect(stats.holdBudgetBytes).toBe(budget.bytes);
      expect(stats.heldBytes).toBeLessThanOrEqual(budget.bytes);
      expect(stats.heldSegments).toBeGreaterThan(0);
      expect(stats.holdTrimmedSegments).toBe(10 - stats.heldSegments);
      expect(stats.holdTrimmedSegments).toBeGreaterThan(0);
      // Unfixed, this append refused horse_archive_byte_capacity and capture
      // stopped: every published segment was held.
      expect(s.capacityRefusal([at(11, 1_100)])).toBeNull();
      expect(s.append(at(11, 1_100))).toBe('recorded');
      expect(s.append(at(12, 1_200))).toBe('recorded');
      const kept = s.readHand(journalHash('hand')).map((r) => r.sequence);
      // The oldest held segments (the start of the window) are all still there.
      for (let n = 1; n <= stats.heldSegments; n++) expect(kept).toContain(n);
      expect(kept).toContain(11);
      expect(kept).toContain(12);
      expect(s.storageStats().archive!.compressedBytes).toBeLessThanOrEqual(maxBytes);
      expect(warn.mock.calls.flat().join(' ')).toMatch(
        /evidence hold exceeds its budget of half the archive; kept its oldest \d+ segments/
      );
      const heldSegments = stats.heldSegments;
      s.close();
      // The next open with the same window keeps exactly the trimmed set and
      // remembers what the budget released.
      const again = open(dir, { maxBytes, hold: { fromMs: 1, untilMs: 100_000 } });
      expect(again.storageStats().archive).toMatchObject({
        heldSegments,
        holdTrimmedSegments: 10 - heldSegments,
      });
    } finally {
      warn.mockRestore();
    }
  });
  it('a hold inside its budget is kept whole and reports its bytes', () => {
    const dir = folder();
    fullArchive(dir);
    const s = open(dir, { hold: { fromMs: 250, untilMs: 450 } });
    const native = new DatabaseSync(catalogPath(dir), { readOnly: true });
    const bytes = Number(
      native.prepare('SELECT sum(bytes) AS n FROM archive_segments WHERE rowid IN (3,4)').get()!.n
    );
    native.close();
    expect(s.storageStats().archive).toMatchObject({
      heldSegments: 2,
      heldBytes: bytes,
      holdTrimmedSegments: 0,
    });
  });
  it('a hold table written by an earlier release gains its bytes in place at the next open', () => {
    const dir = folder();
    fullArchive(dir);
    open(dir, { hold: { fromMs: 250, untilMs: 450 } }).close();
    const native = new DatabaseSync(catalogPath(dir));
    const row = native.prepare('SELECT * FROM archive_hold WHERE id=1').get()!;
    native.exec(`DROP TABLE archive_hold;
      CREATE TABLE archive_hold(id INTEGER PRIMARY KEY CHECK(id=1), from_ms INTEGER NOT NULL,
        until_ms INTEGER NOT NULL, first_rowid INTEGER NOT NULL, last_rowid INTEGER NOT NULL,
        segments INTEGER NOT NULL, records INTEGER NOT NULL) STRICT;`);
    native
      .prepare('INSERT INTO archive_hold VALUES(1,?,?,?,?,?,?)')
      .run(row.from_ms, row.until_ms, row.first_rowid, row.last_rowid, row.segments, row.records);
    native.close();
    const s = open(dir, { hold: { fromMs: 250, untilMs: 450 } });
    expect(s.storageStats().archive).toMatchObject({
      heldSegments: 2,
      heldBytes: row.bytes,
      holdTrimmedSegments: 0,
    });
  });
});

class Writer implements HorseJournalWorker {
  sent: Array<Parameters<HorseJournalWorker['postMessage']>[0]> = [];
  listeners = new Map<string, (message: any) => void>();
  terminate = vi.fn(async () => 0);
  on(event: string, callback: (message: any) => void) {
    this.listeners.set(event, callback);
  }
  postMessage(message: Parameters<HorseJournalWorker['postMessage']>[0]) {
    this.sent.push(message);
  }
  emit(message: any) {
    this.listeners.get('message')?.(message);
  }
  appends() {
    return this.sent.filter((m) => m.type === 'APPEND') as Array<{ records: HorseJournalRecord[] }>;
  }
  ack() {
    const batch = this.appends().at(-1)!.records;
    this.emit({
      type: 'ACK',
      receipts: batch.map((r) => ({ eventId: r.eventId, sha256: r.sha256, status: 'recorded' })),
    });
  }
}

describe('a publisher stopped at a fence re-arms itself with a fresh writer', () => {
  const REARM_MS = (journal as unknown as { HORSE_JOURNAL_REARM_MS?: number })
    .HORSE_JOURNAL_REARM_MS;
  const setup = (writers: Writer[]) => {
    vi.useFakeTimers();
    const first = new Writer(),
      notes: string[] = [];
    const restart = vi.fn(() => {
      const w = writers.shift();
      if (!w) throw Error('no writer');
      return w;
    });
    const p = new HorseDecisionJournalPublisher(first, (x) => notes.push(x), {
      restart,
      now: () => Date.now(),
      wallNow: () => Date.parse('2026-09-28T01:04:07.621Z'),
    });
    return { first, p, notes, restart };
  };
  it('retry_exhausted: a minute later a fresh writer captures the kept queue, with no engine restart', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const b = new Writer(),
        c = new Writer(),
        fresh = new Writer();
      const { first, p, notes, restart } = setup([b, c, fresh]);
      p.record('decision', 'hand', 'turn', { n: 1 });
      first.emit({ type: 'READY' });
      const kept = first.appends()[0]!.records.map((r) => r.eventId);
      // Every writer is too slow to acknowledge: the five-second watchdog.
      for (const w of [first, b, c]) {
        if (w !== first) w.emit({ type: 'READY' });
        await vi.advanceTimersByTimeAsync(8_000);
      }
      expect(p.health()).toMatchObject({ mode: 'failed', lastFailureReason: 'retry_exhausted' });
      expect(p.health().capture).toMatch(
        /^not running: capture stopped at retry_exhausted since 2026-09-28T01:04:07\.621Z; a fresh writer is started every minute until one captures;/
      );
      expect(restart).toHaveBeenCalledTimes(2);
      expect(REARM_MS).toBe(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(restart).toHaveBeenCalledTimes(3);
      expect(notes).toContain('phase15_journal_rearm_started');
      fresh.emit({ type: 'READY' });
      expect(fresh.appends()[0]!.records.map((r) => r.eventId)).toEqual(kept);
      fresh.ack();
      expect(p.health()).toMatchObject({ mode: 'ready' });
      p.record('decision', 'hand', 'turn', { n: 2 });
      expect(fresh.appends()).toHaveLength(2);
      fresh.ack();
      expect(notes.filter((n) => n === 'phase15_journal_recorded')).toHaveLength(2);
      const stop = p.stop();
      fresh.emit({ type: 'STOPPED' });
      await stop;
    } finally {
      warn.mockRestore();
    }
  });
  it('termination_unverified: waits for the stuck writer to actually exit, never runs two', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const b = new Writer(),
        fresh = new Writer();
      const { first, p, restart } = setup([b, fresh]);
      let exited!: () => void;
      first.terminate.mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            exited = () => resolve(0);
          })
      );
      p.record('decision', 'hand', 'turn', {});
      first.emit({ type: 'READY' });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(p.health()).toMatchObject({
        mode: 'failed',
        lastFailureReason: 'termination_unverified',
      });
      await vi.advanceTimersByTimeAsync(180_000);
      // Still inside its native call: no second writer beside it.
      expect(restart).not.toHaveBeenCalled();
      // The minute has long passed: the re-arm starts as soon as it exits.
      exited();
      await vi.advanceTimersByTimeAsync(0);
      expect(restart).toHaveBeenCalledOnce();
      b.emit({ type: 'READY' });
      b.ack();
      expect(p.health().mode).toBe('ready');
      const stop = p.stop();
      b.emit({ type: 'STOPPED' });
      await stop;
    } finally {
      warn.mockRestore();
    }
  });
  it('an integrity refusal stays terminal: ack_mismatch never re-arms', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { first, p, restart } = setup([new Writer()]);
      p.record('decision', 'hand', 'turn', {});
      first.emit({ type: 'READY' });
      first.emit({ type: 'ACK', receipts: [] });
      expect(p.health()).toMatchObject({ mode: 'failed', lastFailureReason: 'ack_mismatch' });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(restart).not.toHaveBeenCalled();
      expect(p.health().capture).toMatch(/^not running: capture stopped for good at ack_mismatch/);
      await p.stop();
    } finally {
      warn.mockRestore();
    }
  });
  it('a re-arm that throws is counted and logged, never unhandled, and the next minute tries again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const writers: Writer[] = [],
        fresh = new Writer();
      const { first, p, notes, restart } = setup(writers);
      p.record('decision', 'hand', 'turn', { n: 1 });
      first.emit({ type: 'READY' });
      // The replacement start throws: restart_failed, a re-armable stop.
      first.listeners.get('error')?.(new Error('died'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(p.health()).toMatchObject({ mode: 'failed', lastFailureReason: 'restart_failed' });
      // The first re-arm is handed a writer this publisher already owned:
      // attaching it throws inside the re-arm's continuation.
      writers.push(first, fresh);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(notes).toContain('phase15_journal_rearm_failed');
      expect(warn.mock.calls.flat().join(' ')).toMatch(
        /capture re-arm failed after=restart_failed queued=1; trying again in a minute/
      );
      expect(p.health().mode).toBe('failed');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(restart).toHaveBeenCalledTimes(3);
      fresh.emit({ type: 'READY' });
      fresh.ack();
      expect(p.health().mode).toBe('ready');
      const stop = p.stop();
      fresh.emit({ type: 'STOPPED' });
      await stop;
    } finally {
      warn.mockRestore();
    }
  });
  it('a stop while waiting to re-arm starts nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { first, p, restart } = setup([]);
      p.record('decision', 'hand', 'turn', {});
      first.emit({ type: 'READY' });
      first.listeners.get('error')?.(new Error('died'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(p.health().mode).toBe('failed');
      await p.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('/health says plainly when the hold is what crowds capture', () => {
  it('names the hold, its bytes and its budget', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const w = new Writer(),
        p = new HorseDecisionJournalPublisher(w, () => {}, {
          wallNow: () => Date.parse('2026-09-28T01:04:07.621Z'),
        });
      w.emit({ type: 'READY' });
      p.health();
      w.emit({
        type: 'STATS',
        stats: {
          archive: {
            compressedBytes: 8_589_934_095,
            maxBytes: 8_589_934_592,
            segments: 723_624,
            publishedSegments: 723_624,
            pendingSegments: 0,
            heldSegments: 237_613,
            heldBytes: 1_490_000_000,
            holdBudgetBytes: 4_294_967_296,
            holdTrimmedSegments: 0,
            retiredSegments: 4_098,
            maxSegments: 2_000_000,
          },
        },
      });
      expect(p.health()).toMatchObject({
        heldBytes: 1_490_000_000,
        holdBudgetBytes: 4_294_967_296,
        holdTrimmedSegments: 0,
      });
      expect(p.health().capture).toMatch(
        / held=237613 unpublished=0 retired=4098 heldBytes=1490000000 holdBudgetBytes=4294967296 holdTrimmed=0$/
      );
      p.record('decision', 'hand', 'turn', {});
      w.emit({ type: 'UNAVAILABLE', reason: 'archive_bytes' });
      expect(p.health().capture).toMatch(
        /^not running: paused since 2026-09-28T01:04:07\.621Z at archive_bytes: the evidence hold is crowding capture, no published segment outside it is left to retire/
      );
      void p.stop();
    } finally {
      warn.mockRestore();
    }
  });
});
