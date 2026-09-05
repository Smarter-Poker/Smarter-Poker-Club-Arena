/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: EVERY TAG HAS A CONSUMER (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "there is absolutely no point to keep upgrading and enhancing the
 * logic of the horses if nothing reads the tags. I bet there are 1000's of
 * tag rows that exist and the only code that touches that table is the
 * tagger itself."
 *
 * Measured before the fix, week to 2026-09-05: 38 tags, 249,475 rows, six
 * tags read. This law makes that state impossible to reach again quietly:
 *
 *   1. every tag literal HorseHandReview.detectLeaks can emit is a `tag` row
 *      in HorseDataLedger.TAG_CONSUMERS (the `_won` twin of a `flag()` tag
 *      is the same row);
 *   2. every row whose consumer is not 'measurement' names a function that
 *      exists AND a tag-list constant in HorseLogic or a gate in
 *      HorseSelfTuner that mentions the tag by name - a consumer that does
 *      not read the tag is the exact lie this law exists to catch;
 *   3. a 'measurement' row carries a reason of at least 40 characters;
 *   4. every ledger tag row is emitted by the detector (no ghosts).
 *
 * The daily audit's fn_audit_tag_consumers reads the same rows from
 * horse_data_ledger and raises tag_unread when a measurement tag carries
 * real volume, so the registry and the production data agree on what is
 * read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TAG_CONSUMERS, ledgerByKind } from '../engine/HorseDataLedger.js';

const SRC = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Every tag the detector can emit, `_won` twins collapsed to the loss tag. */
function emittedTags(): Set<string> {
  const src = read('services/HorseHandReview.ts');
  const start = src.indexOf('function detectLeaks');
  const body = start >= 0 ? src.slice(start) : src;
  const NOT_TAGS = new Set([
    'preflop',
    'flop',
    'turn',
    'river',
    'showdown',
    'fold',
    'call',
    'bet',
    'raise',
    'all_in',
    'check',
  ]);
  const raw = new Set<string>();
  // A statement is everything up to the next semicolon; a flag()/push()
  // statement may span lines and nest parentheses (boardHasPair(...)).
  for (const stmt of body.split(';')) {
    if (!/\bflag\(/.test(stmt) && !/tags\.push\(/.test(stmt)) continue;
    // the `flag` helper's own definition mentions no literal tag
    if (/const flag = /.test(stmt)) continue;
    for (const m of stmt.matchAll(/'([a-z0-9_]+)'/g)) {
      if (!NOT_TAGS.has(m[1])) raw.add(m[1]);
    }
  }
  const out = new Set<string>();
  for (const t of raw) {
    // river_aggr_won is the historical spelling of river_aggr_lost's win side
    if (t.endsWith('_won') && raw.has(t.slice(0, -4))) continue;
    out.add(t);
  }
  return out;
}

describe('LAW: every tag has a consumer', () => {
  const emitted = emittedTags();
  const registered = new Map(TAG_CONSUMERS.map((t) => [t.key, t]));

  it('the detector emits tags (the parser is not silently empty)', () => {
    expect(emitted.size).toBeGreaterThanOrEqual(20);
  });

  it('every emitted tag is registered with a consumer', () => {
    const missing = [...emitted].filter((t) => !registered.has(t)).sort();
    expect(
      missing,
      'tags HorseHandReview emits with no row in HorseDataLedger.TAG_CONSUMERS - add a row naming the code that reads it, or a measurement row saying why nothing does'
    ).toEqual([]);
  });

  it('every registered tag is emitted (no ghosts)', () => {
    const ghosts = [...registered.keys()].filter((t) => !emitted.has(t)).sort();
    expect(ghosts, 'ledger tag rows the detector no longer emits').toEqual([]);
  });

  it('a consumer that is not measurement names code that reads the tag by name', () => {
    const logic = read('engine/HorseLogic.ts');
    const tuner = read('services/HorseSelfTuner.ts');
    for (const t of TAG_CONSUMERS) {
      if (t.consumer === 'measurement') continue;
      const fns = t.consumer.match(/\b[A-Za-z]+\.[a-zA-Z]+\b|\bHorseSelfTuner\b/g) ?? [];
      expect(fns.length, `${t.key}: consumer '${t.consumer}' names no function`).toBeGreaterThan(0);
      const inLogic = new RegExp(`'${t.key}'`).test(logic);
      const inTuner = new RegExp(`'${t.key}'`).test(tuner);
      expect(
        inLogic || inTuner,
        `${t.key}: registered as consumed by '${t.consumer}' but neither HorseLogic.ts nor HorseSelfTuner.ts mentions the tag by name`
      ).toBe(true);
      for (const fn of fns) {
        const [mod, name] = fn.includes('.') ? fn.split('.') : [fn, ''];
        const src = mod === 'HorseLogic' ? logic : mod === 'HorseSelfTuner' ? tuner : '';
        expect(
          src.length,
          `${t.key}: consumer module ${mod} is not a known reader`
        ).toBeGreaterThan(0);
        if (name) {
          expect(
            src.includes(`function ${name}(`) || src.includes(`${name}(`),
            `${t.key}: consumer ${fn} does not exist`
          ).toBe(true);
        }
      }
    }
  });

  it('a measurement tag says why nothing reads it', () => {
    for (const t of TAG_CONSUMERS) {
      if (t.consumer !== 'measurement') continue;
      expect(t.note.length, `${t.key}: a measurement row needs a reason`).toBeGreaterThanOrEqual(
        40
      );
    }
  });

  it('the tag rows reach the synced ledger', () => {
    const rows = ledgerByKind('tag');
    expect(rows.length).toBe(TAG_CONSUMERS.length);
  });
});
