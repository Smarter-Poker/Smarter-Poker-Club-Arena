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
 *   2. no tag claims a retired HorseLogic helper as a live reader; the five
 *      actual tuner gates name their diagnostic-only proposal consumer;
 *   3. a 'measurement' row carries a reason of at least 40 characters;
 *   4. every ledger tag row is emitted by the detector (no ghosts).
 *
 * The daily audit's fn_audit_tag_consumers reads the same rows from
 * horse_data_ledger and raises tag_unread when a measurement tag carries
 * real volume, so the registry and the production data agree on what is
 * read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

/** The tags the SQL side emits (V49): source names the function, not the file. */
const isSqlTag = (t: { source: string }): boolean => t.source.startsWith('fn_');

describe('LAW: every tag has a consumer', () => {
  const emitted = emittedTags();
  const registered = new Map(TAG_CONSUMERS.map((t) => [t.key, t]));
  const handTags = TAG_CONSUMERS.filter((t) => !isSqlTag(t));
  const sqlTags = TAG_CONSUMERS.filter(isSqlTag);

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

  it('every registered HAND tag is emitted by the detector (no ghosts)', () => {
    const ghosts = handTags
      .map((t) => t.key)
      .filter((t) => !emitted.has(t))
      .sort();
    expect(ghosts, 'ledger tag rows the detector no longer emits').toEqual([]);
  });

  it('every registered SQL tag has a source migration (installation is a separate gate)', () => {
    expect(sqlTags.length, 'the V49 frequency tags are registered').toBeGreaterThanOrEqual(9);
    const migDir = join(process.cwd(), '..', 'supabase', 'migrations');
    const sql = readdirSync(migDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(migDir, f), 'utf8'))
      .join('\n');
    for (const t of sqlTags) {
      expect(
        sql.includes(`'${t.key}'`),
        `${t.key} is registered as an SQL-emitted tag but no migration writes it`
      ).toBe(true);
      expect(
        t.consumer.includes('fn_') || t.consumer === 'measurement',
        `${t.key}: an SQL tag's consumer must name the function that reads it`
      ).toBe(true);
    }
  });

  it('diagnostic readers are called by the actual nightly study', () => {
    const tuner = read('services/HorseSelfTuner.ts');
    const body = tuner.slice(tuner.indexOf('export async function runSelfTune'));
    expect(body).toContain('diagnoseAndNudge(');
    expect(body).toContain('leaksByHorse.get(horseId)');
    // This is a wiring check only. HorseSelfTunerAtomicIntegration runs the
    // real study for every registered hand tag and checks its persisted use.
  });

  it('does not claim that historical diagnostic helpers are live tag consumers', () => {
    for (const t of handTags) {
      expect(t.consumer, t.key).not.toContain('HorseLogic.');
      if (t.consumer !== 'measurement') {
        expect(t.consumer, t.key).toBe('HorseSelfTuner.diagnoseAndNudge');
        expect(t.note, t.key).toContain('diagnostic proposal');
      }
      expect(t.note, t.key).toContain('no policy authority');
    }
  });

  it('a measurement tag explains its diagnostic-only boundary', () => {
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
