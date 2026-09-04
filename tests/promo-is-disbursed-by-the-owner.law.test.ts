/**
 * PROMO IS DISBURSED BY THE OWNER, AND IT LANDS AS ORDINARY CHIPS.
 *
 * 2026-09-03, Dan (binding): "PROMO FUNDS ARE PAID DIRECTLY TO CLUBS, OR
 * PLAYERS DIRECTLY FROM THE UNION OWNER (OR CLUB OWNERS WITHOUT ANY UNION
 * AFFILIATION)... FOR NOW, PROMO'S ARE DISBURSED MANUALLY BY OWNERS, AND
 * LEADER BOARDS IS THE ONLY PROMO THAT GETS PAID OUT BY THE PROMO WALLET."
 * "PROMO CHIPS ARE TREATED EXACTLY LIKE REGULAR CHIPS ALWAYS."
 *
 * Before this, the promo float had taken 60,023.71 from the BBJ and paid out
 * 0.00: every route that existed moved it sideways into another promo float,
 * and the one automatic payout could not run at all.
 *
 * The rules this pins:
 *
 *   - fn_promo_disburse is the owner's door: union owner -> member club, union
 *     owner -> a player in one, unaffiliated club owner -> a player in that club;
 *   - a club inside a union cannot disburse - its union owner does;
 *   - it always lands as ordinary chips (chip_treasury / chip_balance), never a
 *     promo_balance and never a playthrough lock;
 *   - it declares its counterparty, so no leg lands in settlement_suspense;
 *   - it is op-keyed, so a retried click returns the first answer;
 *   - the union-funded leaderboard declares its counterparty like the
 *     club-funded one already did;
 *   - wallet_transactions knows the word 'leaderboard_payout', without which
 *     every leaderboard round with a winner aborted on the first credit.
 *
 * Rolled-back probes against production (transcripts in
 * docs/changelog/2026-09-03-chip-std-promo-model.md): three disbursements moved
 * 365.75 with conservation 0.00 and one declared ledger row each; a union-funded
 * leaderboard paid three winners 175.00 out of the promo wallet; a club-funded
 * one paid the same from its seed and released the remainder to the club promo
 * float.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
function read(fragment: string): string {
  const f = readdirSync(DIR)
    .filter((x) => x.includes(fragment))
    .sort()
    .pop();
  expect(f, `the migration containing "${fragment}" is missing`).toBeTruthy();
  return readFileSync(resolve(DIR, f as string), 'utf8');
}
const DISBURSE = read('the_promo_disbursement_speaks_the_ledgers_own_word');
const LB_UNION = read('the_union_funded_leaderboard_names_its_counterparty');
const LB_WORD = read('a_leaderboard_win_is_a_word_the_wallet_knows');

function body(sql: string, name: string): string {
  const open = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(open, `${name} has moved or gone`).toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('promo is disbursed by the owner', () => {
  it('ships the one owner door', () => {
    expect(DISBURSE).toContain('CREATE OR REPLACE FUNCTION public.fn_promo_disburse');
  });

  it('lets only the union owner spend union promo, and only a club owner spend club promo', () => {
    const b = body(DISBURSE, 'fn_promo_disburse');
    expect(b).toContain('Only The Union Owner May Disburse Union Promo');
    expect(b).toContain('Only The Club Owner May Disburse Club Promo');
    expect(b).toMatch(/FROM unions u WHERE u\.id = v_union AND u\.owner_id = v_actor/);
  });

  it('refuses a club that belongs to a union: its union owner disburses', () => {
    expect(body(DISBURSE, 'fn_promo_disburse')).toContain(
      'This Club Belongs To A Union; Its Union Owner Disburses The Promo'
    );
  });

  it('lands as ordinary chips, never a promo balance and never a playthrough lock', () => {
    const b = body(DISBURSE, 'fn_promo_disburse');
    expect(b).toMatch(/SET chip_treasury = COALESCE\(chip_treasury, 0\) \+ v_amt/);
    expect(b).toMatch(/SET chip_balance = COALESCE\(chip_balance, 0\) \+ v_amt/);
    expect(b).not.toMatch(/SET promo_balance\s*=\s*COALESCE\(promo_balance, 0\)\s*\+/);
    expect(b).not.toContain('promo_playthrough_required');
    expect(b).toContain("'lands_as', 'ordinary_chips'");
  });

  it('declares both source shapes so no leg lands in suspense', () => {
    const b = body(DISBURSE, 'fn_promo_disburse');
    expect(b).toMatch(
      /fn_ca_declare_ledger\('promo', 'union_wallet', v_union, NULL,\s*'promo_disburse:'/
    );
    expect(b).toMatch(
      /fn_ca_declare_ledger\('promo', 'promo_wallet', v_club, NULL,\s*'promo_disburse:'/
    );
    expect(b).toContain("ARRAY['union_wallets']");
    expect(b).toContain("ARRAY['clubs']");
  });

  it('refuses a short float and replays an op instead of paying twice', () => {
    const b = body(DISBURSE, 'fn_promo_disburse');
    expect(b).toContain("'Insufficient Promo Balance'");
    expect(b).toMatch(/metadata ->> 'op_id' = v_op::text/);
    expect(b).toContain("'replayed', true");
  });

  it('is not an anonymous door', () => {
    expect(DISBURSE).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_promo_disburse\([^)]*\)\s*FROM PUBLIC, anon;/
    );
    expect(DISBURSE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_promo_disburse\([^)]*\)\s*TO authenticated, service_role;/
    );
  });
});

describe('the leaderboard is the one automatic promo payout, and it can run', () => {
  it('declares the counterparty on the union-funded branch as well as the club one', () => {
    const b = body(LB_UNION, 'fn_payout_leaderboard');
    const unionBranch = b.slice(
      b.indexOf("IF v_plan ->> 'funding_owner_type' = 'union' THEN", b.indexOf('v_seed_debit'))
    );
    expect(unionBranch).toContain(
      "PERFORM set_config('app.ledger_counterparty', 'leaderboard_round', true);"
    );
    expect(unionBranch).toContain('UPDATE public.union_wallets');
    // the club branch keeps its declaration
    expect(b).toContain('UPDATE public.clubs');
    expect((b.match(/app\.ledger_counterparty', 'leaderboard_round'/g) || []).length).toBe(2);
  });

  it('keeps the waterfall: seed first, then the promo float, then the operating wallet', () => {
    const b = body(LB_UNION, 'fn_payout_leaderboard');
    expect(b).toContain('v_seed_debit := LEAST(v_total, v_seed_available);');
    expect(b).toContain('v_promo_debit := LEAST(v_total - v_seed_debit, v_promo_available);');
    expect(b).toContain('v_overlay := v_total - v_seed_debit - v_promo_debit;');
  });

  it('teaches the wallet the word a leaderboard win is written under', () => {
    expect(LB_WORD).toContain(
      'ALTER TABLE public.wallet_transactions DROP CONSTRAINT wallet_transactions_category_check'
    );
    expect(LB_WORD).toContain("'leaderboard_payout'");
    expect(LB_WORD).toContain('NOT VALID');
    expect(LB_WORD).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('proves the word both ways before it commits', () => {
    expect(LB_WORD).toContain('LEADERBOARD_WORD_SELFCHECK: leaderboard_payout is still refused');
    expect(LB_WORD).toContain(
      'LEADERBOARD_WORD_SELFCHECK: the wallet accepted a category it should not know'
    );
  });
});
