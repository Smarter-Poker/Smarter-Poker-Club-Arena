/* THE WRITER VALIDATES EACH RECORD ONCE (2026-09-29).
 *
 * On the serving release fa480b9b both Horse decision-shard writers shed 8% and
 * 18% of what they were offered at queue_capacity, steadily, with no lock
 * contention. The writer's CPU per 16-record batch was about 20 ms on the host
 * (read off /proc/<pid>/task: 10-12% of a core for about 6 batches a second) and
 * about 37 ms here, and almost all of it was one check done five times: a
 * segment was decoded as built, as reserved in the catalog, as staged, as
 * published, and once more from the catalog, and every decode re-parsed each
 * record's body and re-canonicalised it. Measured on a representative batch:
 * 5 record validations and 15 canonical serialisations per record.
 *
 * Validating a line is a pure function of its bytes and a segment's digest is
 * the sha256 of those bytes, so the check is not repeated for a digest that has
 * already passed it. What must NOT change is asserted here too: the digest is
 * still recomputed from the bytes actually read on every decode (a corrupted
 * segment file is still refused even when its digest is remembered), and a
 * segment that was never validated is validated in full.
 *
 * The counting test is red on the source before this change (80 validations
 * and 240 serialisations for one 16-record batch) and green after (16 and 32). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeHorseJournalArchiveOptions } from './config.js';
import { journalHash, makeHorseJournalRecord, type HorseJournalRecord } from './record.js';
import { HorseDecisionJournalStore, forgetValidatedHorseSegments } from './store.js';

const counts = vi.hoisted(() => ({ validate: 0, json: 0 }));
vi.mock('./record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./record.js')>();
  return {
    ...actual,
    validateHorseJournalRecord: (raw: unknown) => {
      counts.validate++;
      actual.validateHorseJournalRecord(raw);
    },
    horseJournalJson: (value: unknown) => {
      counts.json++;
      return actual.horseJournalJson(value);
    },
  };
});

const dirs: string[] = [];
const stores: HorseDecisionJournalStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0))
    try {
      s.close();
    } catch {
      /* closed by the test */
    }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'horse-journal-once-'));
  dirs.push(dir);
  const s = new HorseDecisionJournalStore(dir, {
    archive: runtimeHorseJournalArchiveOptions(dir, {}, { index: 0 }),
  });
  stores.push(s);
  return { dir, store: s };
};

/** About 9 KB of body, the size a decision record measures in production. */
const payload = (n: number) => ({
  schema: 'decision',
  cells: Array.from({ length: 90 }, (_, i) => ({
    id: `cell-${n}-${i}`,
    key: journalHash(`${n}:${i}`).slice(0, 16),
    freq: (i * 37 + n) / 1000,
    flags: [i % 2 === 0, i % 3 === 0],
  })),
});
const HAND = journalHash('hand-under-test');
const batch = (from: number, size = 16): HorseJournalRecord[] =>
  Array.from({ length: size }, (_, i) =>
    makeHorseJournalRecord(
      {
        producerId: '10000000-0000-4000-8000-000000000001',
        sequence: from + i,
        atMs: 1_000 + from + i,
        sourceRelease: null,
        kind: 'decision',
        handKey: HAND,
        turnKey: journalHash(`turn-${from + i}`),
      },
      payload(from + i)
    )
  );

describe('the writer validates each record once', () => {
  it('walks each record a bounded number of times for one 16-record batch', () => {
    const { store } = open();
    const records = batch(1);
    expect(Buffer.byteLength(records[0]!.body)).toBeGreaterThan(5_000);
    forgetValidatedHorseSegments();
    counts.validate = 0;
    counts.json = 0;
    expect(store.appendBatch(records)).toEqual(Array(16).fill('recorded'));
    // One validation per record, at the door. Before this change the same
    // batch was validated 80 times (5 per record).
    expect(counts.validate).toBeLessThanOrEqual(16);
    // Two canonical serialisations per record (its capture and the identity
    // comparison it feeds). Before this change: 240 (15 per record).
    expect(counts.json).toBeLessThanOrEqual(2 * 16);
  });

  it('still refuses an invalid record before anything is written', () => {
    const { store } = open();
    const records = batch(1);
    const forged = { ...records[3]!, atMs: records[3]!.atMs + 1 };
    expect(() => store.appendBatch([...records.slice(0, 3), forged])).toThrow('Invalid');
    // Nothing of the refused batch reached custody.
    expect(store.readHand(HAND)).toEqual([]);
  });

  it('validates a segment it has never seen in full, and once', () => {
    const { store } = open();
    store.appendBatch(batch(1));
    expect(store.readHand(HAND)).toHaveLength(16);
    forgetValidatedHorseSegments();
    counts.validate = 0;
    expect(store.readHand(HAND)).toHaveLength(16);
    // The readback decodes the segment file it has never validated: every one
    // of its 16 records is validated, and not more than once.
    expect(counts.validate).toBeGreaterThanOrEqual(16);
    expect(counts.validate).toBeLessThanOrEqual(2 * 16);
    counts.validate = 0;
    expect(store.readHand(HAND)).toHaveLength(16);
    expect(counts.validate).toBeLessThanOrEqual(16);
  });

  it('never lets a remembered digest excuse changed bytes on disk', () => {
    const { dir, store } = open();
    store.appendBatch(batch(1));
    expect(store.readHand(HAND)).toHaveLength(16);
    const segments = join(dir, 'archive', 'segments');
    const file = readdirSync(segments).find((name) => name.endsWith('.ndjson.gz'))!;
    // Flip one byte in the middle of the published segment: same size, same
    // catalog row, and its uncompressed digest is in the validated set.
    const fd = openSync(join(segments, file), 'r+');
    try {
      const at = 40;
      const one = Buffer.alloc(1);
      readSync(fd, one, 0, 1, at);
      one[0] = one[0]! ^ 0xff;
      writeSync(fd, one, 0, 1, at);
    } finally {
      closeSync(fd);
    }
    expect(() => store.readHand(HAND)).toThrow();
  });
});
