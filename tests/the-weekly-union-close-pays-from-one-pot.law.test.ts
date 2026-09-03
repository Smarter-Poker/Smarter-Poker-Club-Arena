/**
 * THE WEEKLY UNION CLOSE PAYS FROM THE RAKE TREASURY, AND ONLY FROM IT.
 *
 * 2026-09-03, Chip Accounting Standard Phase 2.1 (lane-2 audit F1, CRITICAL).
 *
 * The close used to debit two union pots for one payout: the rake treasury
 * by the period total AND the general bank by the clubs' share, while the
 * clubs received the share once. The retained share vanished and the payout
 * left twice. Its guard demanded that the general bank cover a treasury
 * payout, so a union with 2.05M in the treasury and 69k in the bank would
 * have refused a 160k week forever.
 *
 * The rules this pins are the ones that keep chips conserved on the one
 * day a week real money moves between the union and its clubs:
 *
 *   - the treasury is debited by the period total, once;
 *   - the retained share is CREDITED to the general bank, never debited;
 *   - the general bank is never a source and never consulted by the guard;
 *   - conservation is asserted on the balances inside the guarded section,
 *     so a miss rolls the whole close back;
 *   - the club credits are op-keyed, so a retried close cannot pay twice;
 *   - the union side is declared through fn_ca_declare_ledger with the
 *     union_wallets auto-ledger skipped, and the retained share is written
 *     as one explicit union_wallet -> union_bank row.
 *
 * Rolled-back probe on the real 2026-08-24..08-31 period (transcript in
 * docs/changelog/2026-09-03-chip-std-phase2-union-close.md): treasury
 * -962,179.99, bank +961,039.51, clubs +1,140.48, sum 0.00, replay refused.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const FILE = readdirSync(DIR)
  .filter((f) => f.includes('the_weekly_union_close_pays_from_the_rake_treasury'))
  .sort()
  .pop();
const SQL = FILE ? readFileSync(resolve(DIR, FILE), 'utf8') : '';

/** The function body, bounded by its own dollar-quoted block. */
function body(): string {
  const open = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close');
  expect(open, 'fn_union_weekly_rakeback_close has moved or gone').toBeGreaterThan(-1);
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  expect(end, 'the function body is not dollar-quoted as expected').toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe('the weekly union close pays from one pot', () => {
  it('ships as a migration at all', () => {
    expect(FILE, 'the phase-2.1 migration is missing').toBeTruthy();
  });

  it('debits the rake treasury by the period total, once', () => {
    expect(body()).toMatch(/rake_wallet\s*=\s*rake_wallet\s*-\s*v_period_total/);
    expect(body()).not.toMatch(/LEAST\(v_period_total,\s*COALESCE\(v_wallet\.rake_wallet/);
  });

  it('credits the retained share to the general bank and never debits it', () => {
    const b = body();
    expect(b).toMatch(/chip_balance\s*=\s*chip_balance\s*\+\s*v_retained/);
    expect(b).not.toMatch(/chip_balance\s*=\s*chip_balance\s*-\s*v_payout_total/);
  });

  it('never consults the general bank in the solvency guard', () => {
    const b = body();
    expect(b).not.toMatch(/v_payout_total\s*>\s*COALESCE\(v_wallet\.chip_balance/);
    expect(b).toMatch(/v_period_total\s*>\s*COALESCE\(v_wallet\.rake_wallet,\s*0\)/);
  });

  it('asserts conservation on the balances inside the guarded section', () => {
    const b = body();
    const guard = b.indexOf('guarded money section');
    const assert = b.indexOf('conservation violation in the weekly union close');
    const handler = b.indexOf('EXCEPTION WHEN OTHERS THEN', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(assert).toBeGreaterThan(guard);
    expect(handler, 'the guarded section has no handler').toBeGreaterThan(assert);
    expect(b).toMatch(/round\(v_new_rw - v_rw_before, 2\)\s*<>\s*round\(-v_period_total, 2\)/);
    expect(b).toMatch(
      /round\(v_clubs_after - v_clubs_before, 2\)\s*<>\s*round\(v_payout_total, 2\)/
    );
  });

  it('keys every club credit so a retried close cannot pay twice', () => {
    expect(body()).toMatch(/'union_close:' \|\| v_sid::text \|\| ':' \|\| v_club\.club_id::text/);
  });

  it('declares the union side and writes the retained share as one explicit row', () => {
    const b = body();
    expect(b).toMatch(
      /fn_ca_declare_ledger\('rakeback',\s*'union_wallet',\s*p_union_id,\s*v_sid,\s*NULL,\s*ARRAY\['union_wallets'\]\)/
    );
    expect(b).toMatch(/'union_wallet',\s*p_union_id,\s*'union_bank',\s*p_union_id/);
    expect(b).toMatch(/'union_close:' \|\| v_sid::text \|\| ':retained'/);
    // the old "informational" retained credit that moved nothing is gone
    expect(b).not.toContain('chip_balance total unchanged by retention');
  });

  it('keeps the return shape the cascade reads', () => {
    const b = body();
    for (const key of ["'success'", "'clubs_paid'", "'total_rakeback'", "'union_retained'"]) {
      expect(b).toContain(key);
    }
  });
});

/* Part two and three (Dan, 2026-09-03): the basis is the rake the CLUB'S
   PLAYERS generated at the union's games, not the rake from the club's own
   tables. Cash from ca_union_rake_attribution (the seat the player sat
   through, captured hourly), tournaments from tournament_players. */
const ATTR_FILE = readdirSync(DIR)
  .filter((f) => f.includes('every_chip_of_union_rake_knows_which_clubs_player_paid_it'))
  .sort()
  .pop();
const CLOSE_V3_FILE = readdirSync(DIR)
  .filter((f) => f.includes('the_weekly_union_close_shares_the_rake_a_clubs_players_generated'))
  .sort()
  .pop();
const ATTR = ATTR_FILE ? readFileSync(resolve(DIR, ATTR_FILE), 'utf8') : '';
const CLOSE_V3 = CLOSE_V3_FILE ? readFileSync(resolve(DIR, CLOSE_V3_FILE), 'utf8') : '';

function closeBody(sql: string): string {
  const open = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close');
  expect(
    open,
    'fn_union_weekly_rakeback_close missing from the part-three migration'
  ).toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  return sql.slice(start, end);
}

describe("the close shares the rake a club's players generated", () => {
  it('ships the attribution table, its hourly job and the part-three close', () => {
    expect(ATTR_FILE, 'the attribution migration is missing').toBeTruthy();
    expect(CLOSE_V3_FILE, 'the part-three close migration is missing').toBeTruthy();
    expect(ATTR).toContain('CREATE TABLE IF NOT EXISTS public.ca_union_rake_attribution');
    expect(ATTR).toMatch(/cron\.schedule\('ca-union-rake-attribution-hourly'/);
    expect(ATTR).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_attribute_union_rake\(integer\) FROM PUBLIC, anon, authenticated;/
    );
  });

  it('attributes cash by the seat the player sat through and shares rake by pot contribution', () => {
    expect(ATTR).toContain('jsonb_each_text(h.player_contributions)');
    expect(ATTR).toContain('round(c.rake_amount * c.contrib / NULLIF(c.total, 0), 4)');
    expect(ATTR).toMatch(
      /FROM public\.table_seats s\s+WHERE s\.table_id = c\.table_id AND s\.user_id = c\.user_id/
    );
    expect(CLOSE_V3).toContain("s.joined_at >= c.played_at - interval '7 days'");
  });

  it("bases each club's share on its players, cash and tournaments, never on the table's club", () => {
    const b = closeBody(CLOSE_V3);
    expect(b).toContain('FROM ca_union_rake_attribution a');
    expect(b).toContain('FROM tournament_players tp');
    expect(b).toContain('sum(1 + COALESCE(tp.rebuys, 0) + CASE WHEN tp.add_on THEN 1 ELSE 0 END)');
    expect(b).not.toContain('GROUP BY t.club_id, uc.club_commission_rate');
    expect(b).toContain("'basis', 'players_of_the_club_at_union_tables'");
  });

  it('keeps the period total as everything the treasury received and refuses a basis above it', () => {
    const b = closeBody(CLOSE_V3);
    expect(b).toContain(
      'SELECT round(COALESCE(SUM(amount), 0), 2) INTO v_period_total FROM _uwrb_credits'
    );
    expect(b).toContain("'attribution_exceeds_treasury'");
  });

  it('carries part one forward unchanged: separate pots, op keys, the conservation assert', () => {
    const b = closeBody(CLOSE_V3);
    expect(b).toMatch(/rake_wallet\s*=\s*rake_wallet\s*-\s*v_period_total/);
    expect(b).toMatch(/chip_balance\s*=\s*chip_balance\s*\+\s*v_retained/);
    expect(b).toContain('conservation violation in the weekly union close');
    expect(b).toMatch(/'union_close:' \|\| v_sid::text \|\| ':' \|\| v_club\.club_id::text/);
  });
});
