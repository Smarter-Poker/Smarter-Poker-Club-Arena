/**
 * LAW: THE CONSERVATION SCAN READS EVERY EVENT IN ONE PASS (2026-10-03).
 *
 * tourney_money_conservation_deep_daily was `critical` in fn_ca_cron_health:
 * it was cancelled on a statement timeout on 3 of its last 4 nights and
 * returned no verdict for 45 days of tournament money. Pass 2 of
 * fn_tournament_money_conservation called fn_tournament_conservation_delta
 * once per event, 143,479 events at about 4 ms each.
 *
 * fn_tournament_conservation_deltas is the same arithmetic summed once per
 * table. On production it matched the scalar on all 143,543 events and read
 * the 45 days in about 24 s. The native PG17 qualification
 * (conservation-set-native.py) proves whole-population parity and an
 * identical scan outcome.
 *
 * The law has two jobs:
 *   1. pin the migration: one transaction, a live proof, preimage and
 *      authority refusals, the set function declared verbatim, and closed to
 *      every browser role;
 *   2. keep the two readings of the books one question. The set function must
 *      be declared in the same migration as the scalar's latest declaration
 *      or a later one, and it must read every literal the scalar reads. A
 *      change to the scalar that leaves the set function behind fails here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { migrationCorpus } from './helpers/migrationCorpus';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const FIX = 'scripts/ci/fixtures/backed-payout-scan/';
const pins = JSON.parse(read(FIX + 'conservation-set-expectations.json'));
const migration = read(pins.migration);
const deltas = read(FIX + 'conservation-set-deltas.sql');
const before = read(FIX + 'conservation-scan-before.sql');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

/** Every distinct single-quoted literal in a body, comments removed. */
const literals = (sql: string) =>
  new Set([...stripComments(sql).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]));

/** The body between $function$ markers of the last declaration in a file. */
function lastBody(sql: string, name: string): string | null {
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\([\\s\\S]*?AS\\s+\\$function\\$([\\s\\S]*?)\\$function\\$`,
    'g'
  );
  let body: string | null = null;
  for (const m of sql.matchAll(re)) body = m[1];
  return body;
}

describe('the conservation scan reads every event in one pass', () => {
  it('is one transaction with a live proof and named refusals', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(migration).toMatch(/^-- @live-proof: /m);
    for (const code of ['PREIMAGE_CHANGED', 'AUTHORITY_CHANGED', 'SCAN_CHANGED', 'RESULT_CHANGED'])
      expect(migration).toContain('CONSERVATION_SET_' + code);
    for (const key of ['moneyBeforeMD5', 'moneyAfterMD5', 'deltasDefinitionMD5', 'scalarMD5'])
      expect(migration).toContain(pins[key]);
    expect(stripComments(migration)).not.toMatch(
      /\b(?:CREATE INDEX|DROP|cron\.(?:schedule|alter_job|unschedule))\b/i
    );
  });

  it('declares the qualified set function verbatim and closes it to browsers', () => {
    expect(md5(deltas)).toBe(pins.deltasDefinitionMD5);
    expect(migration).toContain(deltas.trimEnd() + ';');
    expect(stripComments(migration).match(/\b(?:GRANT|REVOKE)\b[^;]*;/g)).toEqual([
      'REVOKE ALL ON FUNCTION public.fn_tournament_conservation_deltas(timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_deltas(timestamp with time zone, timestamp with time zone) TO service_role;',
    ]);
    expect(deltas).toMatch(/STABLE SECURITY DEFINER\n SET search_path TO 'public'\n/);
  });

  it('changes only the scan block, and only to the one-pass read', () => {
    expect(md5(before)).toBe(pins.moneyBeforeMD5);
    const { old, new: next, count } = pins.replacement;
    expect(count).toBe(1);
    expect(before.split(old)).toHaveLength(2);
    expect(md5(before.replace(old, next))).toBe(pins.moneyAfterMD5);
    expect(old).toContain('public.fn_tournament_conservation_delta(t.id) AS delta');
    expect(stripComments(next)).not.toContain('fn_tournament_conservation_delta(');
    expect(next).toContain('public.fn_tournament_conservation_deltas(');
    // The window is the scan's own: the same since and the same grace.
    expect(next).toContain(
      "now() - make_interval(days => v_days),\n               now() - interval '30 minutes') d"
    );
    // Pass 1 still asks the scalar about each open alert by name.
    expect(before.replace(old, next)).toContain(
      'v_delta := public.fn_tournament_conservation_delta(v_row.tid);'
    );
  });

  it('selects exactly the events the scan selected', () => {
    for (const clause of [
      "t.status IN ('COMPLETED','CANCELLED')",
      't.ended_at > p_since',
      't.ended_at < p_until',
      "COALESCE(t.variant, '') NOT IN ('spin')",
      'COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0',
    ])
      expect(deltas).toContain(clause);
  });

  it('keeps the set function in step with the latest declared scalar', () => {
    const corpus = migrationCorpus();
    const scalarDecl = corpus.filter(({ sql }) =>
      lastBody(sql, 'fn_tournament_conservation_delta')
    );
    const setDecl = corpus.filter(({ sql }) => lastBody(sql, 'fn_tournament_conservation_deltas'));
    const latestScalar = scalarDecl.at(-1)!;
    const latestSet = setDecl.at(-1)!;
    expect(latestSet, 'the set function is declared').toBeTruthy();
    expect(latestSet.name >= latestScalar.name, latestScalar.name).toBe(true);
    const scalarLits = literals(lastBody(latestScalar.sql, 'fn_tournament_conservation_delta')!);
    const setLits = literals(lastBody(latestSet.sql, 'fn_tournament_conservation_deltas')!);
    const missing = [...scalarLits].filter((l) => !setLits.has(l));
    expect(missing, 'literals the scalar reads that the set function does not').toEqual([]);
    const extra = [...setLits].filter((l) => !scalarLits.has(l)).sort();
    expect(extra, 'only the scan eligibility is the set function’s own').toEqual([
      '', // COALESCE(t.variant, '')
      'CANCELLED',
      'COMPLETED',
      'spin',
    ]);
  });

  it('is qualified natively and routed to the native checks', () => {
    expect(read('scripts/ci/test-backed-payout-scan-postgres.py')).toContain(
      "runpy.run_path(str(FIXTURE/'conservation-set-native.py'))['qualify'](globals())"
    );
    const native = read(FIX + 'conservation-set-native.py');
    for (const proof of [
      'conservation whole-population scalar parity',
      'conservation eligibility parity',
      'conservation scan outcome differs',
      'conservation transaction rollback',
      'conservation successor changed authority or function identity',
      'more than the scan block changed',
    ])
      expect(native).toContain(proof);
    for (const path of [
      pins.migration,
      FIX + 'conservation-set-native.py',
      FIX + 'conservation-set-deltas.sql',
      FIX + 'conservation-scan-before.sql',
      FIX + 'conservation-set-expectations.json',
    ])
      expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
});
