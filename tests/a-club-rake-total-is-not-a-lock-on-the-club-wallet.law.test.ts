/**
 * A CLUB'S RAKE TOTAL IS NOT A LOCK ON ITS WALLET.
 *
 * atomic_distribute_rake ran, once per raked hand,
 *
 *     UPDATE public.club_wallets SET period_rake_collected = ... + p_rake, ...
 *
 * on the club's ONE wallet row, inside the hand's post-commit transaction, so
 * the row stayed locked to COMMIT. Every raked hand at every table of the club
 * queued behind every other, and behind every tournament finish of the club
 * (which takes the same row first and holds it for its whole body). Production,
 * 2026-10-02 18:00-19:45 UTC: 1,518 statement timeouts on that one statement,
 * PostgREST threads killed at 19:37:07, and 180 hands on 116 tables voided as
 * lease_proof_expired at 19:37:26.
 *
 * The columns are a statistic (the UPDATE literally wrote chip_balance =
 * chip_balance). The hand's share now lives per (club, table) in
 * club_table_rake_totals - a table deals one hand at a time, so each row has
 * one writer - and the club figure is the wallet column plus that sum.
 *
 * scripts/ci/test-club-rake-total-is-not-a-lock.py runs the REAL function on a
 * disposable cluster: production's pre-image (md5-pinned), then the shipped
 * migration's own substitution block. Before, an open hand blocks the club's
 * other table and a finish; after, neither, and every figure is still written
 * exactly once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const NAME = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('_a_club_rake_total_is_not_a_lock_on_the_club_wallet.sql'))
  .sort()
  .at(-1);
if (!NAME) throw new Error('the club rake total migration is missing');
const SQL = readFileSync(join(MIGRATIONS, NAME), 'utf8');
const CODE = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');
/** The decoded E'' text of one side of the FIRST substitution (the rake). */
const side = (name: 'v_old' | 'v_new'): string => {
  const block = CODE.slice(CODE.indexOf('DO $subs$'), CODE.indexOf('END $subs$;'));
  const start = block.indexOf(`${name} := `);
  const end = block.indexOf(';\n', start);
  return [...block.slice(start, end).matchAll(/E'((?:[^']|'')*)'/g)]
    .map((m) => m[1].replace(/''/g, "'").replace(/\\n/g, '\n'))
    .join('');
};
const HARNESS = readFileSync(
  join(__dirname, '..', 'scripts', 'ci', 'test-club-rake-total-is-not-a-lock.py'),
  'utf8'
);

describe("a club's rake total is not a lock on its wallet", () => {
  it('removes the per-hand wallet UPDATE and nothing else of the money path', () => {
    const oldText = side('v_old');
    const newText = side('v_new');
    expect(oldText).toMatch(/^\s*UPDATE public\.club_wallets\n\s*SET period_rake_collected/);
    expect(newText).not.toMatch(/UPDATE\s+public\.club_wallets/);
    expect(newText).not.toMatch(/FOR\s+(NO\s+KEY\s+)?UPDATE/i);
    // The receipt still reads the wallet, without a lock.
    expect(newText).toMatch(/SELECT w\.chip_balance INTO v_cw_after\s+FROM public\.club_wallets w/);
  });

  it('keeps the total per table, where each row has one writer', () => {
    expect(CODE).toContain('CREATE TABLE public.club_table_rake_totals');
    expect(CODE).toMatch(/PRIMARY KEY \(club_id, table_id\)/);
    expect(side('v_new')).toMatch(
      /INSERT INTO public\.club_table_rake_totals AS t[\s\S]*ON CONFLICT \(club_id, table_id\) DO UPDATE/
    );
    // CLAUDE.md section 2 rule 7: a statistic row never locks a hot table.
    const table = CODE.slice(
      CODE.indexOf('CREATE TABLE public.club_table_rake_totals'),
      CODE.indexOf(');', CODE.indexOf('CREATE TABLE public.club_table_rake_totals'))
    );
    expect(table).not.toMatch(/REFERENCES/i);
  });

  it('is closed to browsers', () => {
    expect(CODE).toContain('ALTER TABLE public.club_table_rake_totals ENABLE ROW LEVEL SECURITY;');
    expect(CODE).toMatch(/REVOKE ALL ON TABLE public\.club_table_rake_totals FROM anon;/);
    expect(CODE).toMatch(/REVOKE ALL ON TABLE public\.club_table_rake_totals FROM authenticated;/);
  });

  it('the panel reads wallet plus tables, so the figure it shows does not change', () => {
    expect(CODE).toContain("'1374b5a7a5759e631a8f3ebda5199c91'");
    expect(CODE).toMatch(
      /FROM public\.club_table_rake_totals t[\s\S]*WHERE t\.club_id = p_club_id/
    );
    expect(CODE).toContain('PANEL_DOES_NOT_READ_THE_TABLE_TOTALS');
  });

  it('pins both images and refuses to land if the live text moved', () => {
    expect(CODE).toContain("'0ef820b10c57d902b5ab2d5f9e2be8a6'");
    expect(CODE).toContain("'3cb33db39fdcf0359949f941a178158e'");
    expect(CODE).toContain("'b565ebe80035c2b1af996013c4489211'");
    expect(CODE).toContain('RAKE_STILL_LOCKS_THE_CLUB_WALLET');
    expect(SQL).toMatch(/@live-proof: .*'3cb33db39fdcf0359949f941a178158e'/);
  });

  it('backfills nothing and repairs nothing (10.12)', () => {
    expect(CODE).not.toMatch(/cron\.schedule/i);
    expect(CODE).not.toMatch(/\b(backfill|back_pay|backpay|repair|redrive|catchup|resweep)\b/i);
    // The one place the old UPDATE appears is the quoted text it replaces.
    expect(CODE.match(/UPDATE public\.club_wallets/g)?.length).toBe(1);
    expect(side('v_old')).toContain('UPDATE public.club_wallets');
  });

  it('is proved on the real function, before and after, by the harness', () => {
    expect(HARNESS).toContain('before-an-open-hand-blocks-the-clubs-other-table-and-its-finishes');
    expect(HARNESS).toContain('after-an-open-hand-blocks-neither');
    expect(HARNESS).toContain('pre-image-is-production');
    expect(HARNESS).toContain('post-image-is-the-pinned-one');
    expect(HARNESS).toContain('the-same-hand-again-counts-nothing');
    expect(HARNESS).toContain('a-union-hand-still-pays-the-union-rake-treasury');
    // It executes the shipped migration's own text, not a copy of the new body.
    expect(HARNESS).toContain('shipped_for_rake_only(SHIPPED)');
  });
});
