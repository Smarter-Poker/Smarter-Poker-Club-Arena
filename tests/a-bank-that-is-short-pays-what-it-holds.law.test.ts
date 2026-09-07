/**
 * A BANK THAT IS SHORT PAYS WHAT IT HOLDS. IT DOES NOT PAY NOTHING.
 *
 * Measured on production 2026-09-07: three finished tournaments were holding
 * 21,419.57 that belonged to three winners, the oldest since 13:11 the day
 * before. Every other place in all three had been paid to the cent from the
 * same bank.
 *
 *   f7412940  196 entrants  winner owed 13,441.68  bank held 13,261.68
 *   a449e853   81 entrants  winner owed  8,282.69  bank held  8,102.69
 *   afa045db    3 entrants  winner owed     60.00  bank held     55.20
 *
 * `fn_settle_tournament_obligation` refused the WHOLE payment when the bank
 * could not cover the whole obligation:
 *
 *   "Refused 13441.68 to a2bd256e-... for place: the escrow holds 13261.68"
 *
 * so a 180.00 shortfall became a 13,261.68 non-payment - and since the last
 * place paid is always first place, it is always the winner who absorbs it.
 *
 * The 180.00 is bubble protection: both Deep Stacks carry
 * `bubble_protection = true` and one payout row of 180.00 (the buy-in, no
 * position). The settlement counts that against the prize pool - it is in its
 * own `v_pool_kinds` - but the payout structure does not: the percentages sum
 * to exactly 100.0000% and the sum of every player's prize equals `prize_pool`
 * to the cent. The pool promises all of itself to the places AND a refund to
 * the bubble out of the same money.
 *
 * WHO FUNDS BUBBLE PROTECTION IS DAN'S DECISION (10.9: what players are owed
 * in future events). What is pinned here is the amplifier, which is not:
 *
 *   1. a short bank pays what it holds, never zero;
 *   2. it can never pay more than the bank holds;
 *   3. `amount_owed` is untouched, so the remainder stays owed and payable;
 *   4. the alert says what was paid and what is still owed;
 *   5. every other guard in that function is still there - the kill switch,
 *      the manual-adjustment requirement, one-finisher-one-place.
 *
 * These pins read the migration text. The migration proves the behaviour
 * itself: it calls the real frozen obligation inside a subtransaction it rolls
 * back and aborts unless 13,261.68 comes back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .find((f) => f.includes('a_bank_that_is_short_pays_what_it_holds'));
const sql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';

describe('a bank that is short pays what it holds', () => {
  it('the migration exists', () => {
    expect(file, 'the partial-payment migration must not be deleted').toBeTruthy();
  });

  it('it pays the bank balance rather than refusing, and only when there is something there', () => {
    expect(sql).toContain("AND COALESCE((v_can->>''available'')::numeric, 0) >= 0.01");
    expect(sql).toContain("v_pay   := round((v_can->>''available'')::numeric, 2);");
    // and it re-asks the bank with the reduced figure, so the old refusal still
    // guards anything it cannot cover
    const reduce = sql.indexOf("v_pay   := round((v_can->>''available'')");
    const reask = sql.indexOf(
      'v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);',
      reduce
    );
    expect(reask).toBeGreaterThan(reduce);
  });

  it('the remainder stays owed: amount_owed is never reduced', () => {
    expect(sql).not.toMatch(
      /UPDATE\s+public\.tournament_obligations[\s\S]{0,200}SET\s+amount_owed\s*=\s*v_pay/i
    );
    expect(sql).toContain("''still_owed'',v_short");
  });

  it('the edit is made against the catalogue, on text asserted to be unique', () => {
    // 15,900 characters of money path are not retyped for a nine-line change
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).toMatch(/ABORT: the v_can declaration is not unique in the body/);
    expect(sql).toMatch(/ABORT: the escrow-check anchor is not unique in the body/);
    expect(sql).toMatch(/ABORT: the substitution changed nothing/);
  });

  it('every other guard is asserted to survive the edit', () => {
    for (const guard of [
      'payout_frozen',
      'player_already_holds_a_place',
      'ca_manual_adjustments',
      'escrow_short_paid_what_it_holds',
    ]) {
      expect(sql).toContain(`VERIFY FAILED`);
      expect(sql).toContain(guard);
    }
  });

  it('it proves itself on the real frozen obligation and rolls the proof back', () => {
    expect(sql).toContain('zz_rollback_the_probe');
    expect(sql).toMatch(/VERIFY FAILED: the short bank paid % instead of the 13261\.68 it holds/);
    expect(sql).toMatch(/VERIFY FAILED: the probe payment survived its own rollback/);
  });

  it('it does not decide who funds bubble protection', () => {
    // that sets what players are owed in future events, which is Dan's (10.9)
    expect(sql).toMatch(/CLAUDE\.md 10\.9 reserves that for Dan/);
    expect(sql).not.toMatch(/UPDATE\s+public\.tournaments[\s\S]{0,120}payout_structure/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.tournaments[\s\S]{0,120}prize_pool/i);
  });
});
