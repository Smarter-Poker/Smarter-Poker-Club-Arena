/**
 * A SATELLITE AWARD IS FOUND BY ITS PAYOUT, NEVER BY ITS PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * tournament_satellite_awards.payout_id is NOT NULL, UNIQUE and a foreign key
 * to tournament_payouts: every award names exactly one payout. The payout's
 * `position` is a ranking column, and a version-3 (multi-qualifier) satellite
 * leaves it NULL for every unranked co-qualifier by design
 * (20260917201651_satellite_multi_qualifier_receipt_v3, PR #4818). From
 * 2026-09-18 10:10 UTC to 2026-10-01 14:41 UTC, 592 satellite payouts (426
 * satellite_ticket, 166 satellite_seat, 184 satellites) carried a NULL position, and every reader
 * that joined awards to payouts ON (tournament_id, place = position) lost the
 * award for all of them:
 *
 *   - fn_tournament_conservation_delta read issued, never-redeemed tickets as
 *     arrived seats and raised 20 false "retained money it never paid out"
 *     alerts (20.00 ... 2,850.00, 22 open with two bubble events, 2026-10-01);
 *   - fn_pay_backed_payout_shortfalls, which DECIDES backed top-up payments
 *     from an inline copy of that delta, read the same phantom surplus;
 *   - fn_satellite_conservation_audit's funded-seat arm missed the same rows.
 *
 * This law covers every one of them, and every migration written after the
 * fix: none may join the award table to a payout by place = position again,
 * and the fixing migration must keep its install-time assertion that no
 * installed function does.
 *
 * IF THIS TEST IS FAILING you restated one of these functions (or wrote a new
 * one) that locates an award by its place. Join ON a.payout_id = <payout>.id.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FIX = '20261001151646_the_conservation_delta_finds_a_seat_s_award_by_its_payout.sql';

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // 14-digit version prefix: lexical order is chronological order

const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

/** An award joined to a payout by its place: ON a.tournament_id = p.tournament_id AND a.place = p.position */
const PLACE_JOIN =
  /tournament_satellite_awards\s+(\w+)\s+ON\s+\1\.tournament_id\s*=\s*(\w+)\.tournament_id\s+AND\s+\1\.place\s*=\s*\2\.position\b/i;

/**
 * The functions that join tournament_satellite_awards to tournament_payouts.
 * fn_ca_satellite_settlement_receipt is not here on purpose: it refuses every
 * receipt_version other than 2 and already joins awards to payouts ON
 * p.id = a.payout_id.
 */
const READERS = [
  'fn_tournament_conservation_delta',
  'fn_pay_backed_payout_shortfalls',
  'fn_satellite_conservation_audit',
];

/**
 * The newest migration that installs `fn`: either a CREATE OR REPLACE of it,
 * or an in-place patch that names its regprocedure ('public.fn(').
 */
function newestInstaller(fn: string): string {
  const create = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, 'i');
  const patch = new RegExp(`'public\\.${fn}\\(`, 'i');
  let found = '';
  for (const f of files) {
    const sql = stripComments(read(f));
    if (create.test(sql) || patch.test(sql)) found = f;
  }
  return found;
}

describe('a satellite award is found by its payout, never by its place', () => {
  it('the fixing migration is present', () => {
    expect(files, `${FIX} is missing`).toContain(FIX);
  });

  it.each(READERS)('the newest installer of %s is the fix or later', (fn) => {
    const f = newestInstaller(fn);
    expect(f, `no migration installs ${fn}`).toBeTruthy();
    expect(
      f >= FIX,
      `${fn} was last installed by ${f}, before ${FIX}; that body joins the award by place = position`
    ).toBe(true);
  });

  it.each(READERS)('the newest installer of %s joins no award by place = position', (fn) => {
    const f = newestInstaller(fn);
    const sql = stripComments(read(f));
    expect(
      PLACE_JOIN.test(sql),
      `${f} locates a satellite award by place = position. A version-3 co-qualifier's payout has a NULL position. Join ON a.payout_id = <payout>.id.`
    ).toBe(false);
  });

  it('the fix moves the payer and the audit to payout_id, from exact installed bodies', () => {
    const sql = read(FIX);
    expect(sql).toMatch(/'ON a\.payout_id = sp\.id', 2,/);
    expect(sql).toMatch(/'ON a\.payout_id = p\.id', 1,/);
    // pre-image and post-image guards for both patched bodies
    for (const md5 of [
      '9078403312e51a873e6e7462555dcf7e',
      'c4bee1c002152eeae5b85f1e4c9bde1a',
      '462b1c631010e4bab0361967d2da2a75',
      '5d847143055fab40063ee1d968f2bb36',
    ]) {
      expect(sql).toContain(md5);
    }
    // and the delta itself, restated in full
    const delta = stripComments(sql);
    expect((delta.match(/ON\s+a\.payout_id\s*=\s*sp\.id/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the fix refuses to commit while any installed function still joins by place', () => {
    const sql = read(FIX);
    const invariant = sql.slice(sql.indexOf('DO $invariant$'));
    expect(invariant).toMatch(/FROM pg_proc p/);
    expect(invariant).toMatch(/tournament_satellite_awards\\s\+\(\\w\+\)\\s\+ON/);
    expect(invariant).toMatch(/RAISE EXCEPTION 'a satellite award is still located by place = position/);
    expect(invariant.indexOf('COMMIT;')).toBeGreaterThan(0);
  });

  it('no migration written after the fix joins an award by place = position', () => {
    for (const f of files.filter((x) => x > FIX)) {
      expect(PLACE_JOIN.test(stripComments(read(f))), `${f} joins an award by place = position`).toBe(false);
    }
  });
});
