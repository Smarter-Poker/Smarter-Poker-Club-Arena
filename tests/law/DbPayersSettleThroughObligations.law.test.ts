/**
 * =============================================================================
 *  DB PAYERS SETTLE THROUGH OBLIGATIONS (Chip Accounting Standard, Lane A3)
 * =============================================================================
 *
 * docs/CHIP-ACCOUNTING-STANDARD.md 2.2 counted eleven independent payers of a
 * tournament place. Six of them live in the database: the reconciler, the two
 * guarantee sweeps, the spin and heads-up back-pay arms and the final-table
 * deal. Measured 2026-09-02 19:41 UTC, none of them called
 * fn_settle_tournament_obligation, so each carried its own idempotency key and
 * its own idea of what was owed - which is how 5,330 chips were paid twice in
 * 36 hours (2.2, item 3).
 *
 * This law pins the migration that re-pointed them and the later atomic
 * cutover that removed the entire deferred reconciler graph. Active payer
 * bodies settle through fn_settle_tournament_obligation and none of them
 * credits a wallet on its own. It also pins the one-line fix to the settle
 * function's key (it must start with 'tourney:<tournament_id>:' so the club
 * wallet resolver credits the club the player bought in from) and the R3
 * logger's two properties: it watches AFTER INSERT and it can never refuse.
 *
 * If you need a DB payer to move money some other way, change the settle
 * function, not the payer.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const readLatestMigration = (suffix: string): string => {
  const migrations = path.join(process.cwd(), 'supabase', 'migrations');
  const file = fs
    .readdirSync(migrations)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .at(-1);
  if (!file) throw new Error(`migration ending in ${suffix} not found`);
  return fs.readFileSync(path.join(migrations, file), 'utf8');
};

const PAYERS = read('supabase/migrations/20260902201000_db_payers_settle_through_obligations.sql');
const R3 = read('supabase/migrations/20260902201500_r3_money_path_log_only.sql');
const CUTOVER = readLatestMigration('_tournament_places_settle_and_complete_atomically.sql');

const ACTIVE_DIRECT_PAYERS = ['fn_backpay_spin_unpaid_winners', 'fn_final_table_deal'] as const;

/** The body of one CREATE OR REPLACE FUNCTION in a migration file. */
function bodyOf(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) return '';
  const end = sql.indexOf('$function$;', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end);
}

/** The predicate the law enforces, so the negative control tests the SAME rule. */
function settlesThroughObligations(body: string): boolean {
  return (
    body.includes('fn_settle_tournament_obligation(') &&
    !body.includes('fn_credit_and_log(') &&
    !body.includes('credit_player_wallet(')
  );
}

describe('every DB-side tournament payer settles through fn_settle_tournament_obligation', () => {
  it.each(ACTIVE_DIRECT_PAYERS)('%s is redefined by the Lane A3 migration', (name) => {
    expect(bodyOf(PAYERS, name).length).toBeGreaterThan(0);
  });

  it.each(ACTIVE_DIRECT_PAYERS)(
    '%s calls the settle function and never fn_credit_and_log / credit_player_wallet',
    (name) => {
      expect(settlesThroughObligations(bodyOf(PAYERS, name))).toBe(true);
    }
  );

  it('legacy guarantee wrappers are removed with the applying reconciler', () => {
    for (const name of ['fn_pay_backed_payout_shortfalls', 'fn_ca_backpay_guarantee_shortfalls']) {
      expect(bodyOf(PAYERS, name)).toMatch(/fn_tournament_payout_reconcile\([^)]*,\s*true\)/);
    }
    expect(CUTOVER).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_pay_backed_payout_shortfalls\(boolean, integer\) RESTRICT;/
    );
    expect(CUTOVER).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_ca_backpay_guarantee_shortfalls\(boolean, integer\) RESTRICT;/
    );
    expect(CUTOVER).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_tournament_payout_reconcile\(uuid, boolean\) RESTRICT;/
    );
    expect(CUTOVER).not.toMatch(
      /CREATE OR REPLACE (?:FUNCTION|PROCEDURE) public\.(?:fn_tournament_payout_reconcile|fn_pay_backed_payout_shortfalls|fn_ca_backpay_guarantee_shortfalls|fn_tournament_payout_sweep|sp_ca_reconcile_backpaid_events|fn_backpay_hu_winner_shortfalls)\s*\(/
    );
  });

  it('the cutover proves that no deferred reconciliation routine remains installed', () => {
    expect(CUTOVER).toMatch(
      /FROM pg_proc p[\s\S]*?p\.proname IN \([\s\S]*?'fn_tournament_payout_reconcile'[\s\S]*?'fn_pay_backed_payout_shortfalls'[\s\S]*?'fn_backpay_hu_winner_shortfalls'[\s\S]*?deferred tournament payout reconciliation routine remains installed/
    );
  });

  it('retires the Heads-Up single-place backpay instead of looping on atomic refusals', () => {
    expect(CUTOVER).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_backpay_hu_winner_shortfalls\(integer\) RESTRICT;/
    );
    const gameServer = read('server/src/GameServer.ts');
    expect(gameServer).not.toContain("'fn_backpay_hu_winner_shortfalls'");
    expect(gameServer).not.toContain('lastHuBackpayAt');
  });

  it('the final-table deal is user-keyed and no longer writes tournament_payouts itself', () => {
    const body = bodyOf(PAYERS, 'fn_final_table_deal');
    expect(body).toMatch(
      /fn_settle_tournament_obligation\(\s*p_tournament_id, 'final_table_deal', NULL, v_p\.user_id/
    );
    expect(body).not.toMatch(/INSERT INTO public\.tournament_payouts/);
  });

  it('negative control: a payer that credits on its own fails the same predicate', () => {
    const good = bodyOf(PAYERS, 'fn_backpay_spin_unpaid_winners');
    expect(settlesThroughObligations(good)).toBe(true);
    const mutated = good.replace(
      'public.fn_settle_tournament_obligation(',
      'public.fn_credit_and_log('
    );
    expect(settlesThroughObligations(mutated)).toBe(false);
    const stripped = good.split('fn_settle_tournament_obligation(').join('fn_something_else(');
    expect(settlesThroughObligations(stripped)).toBe(false);
    const legacySweep = bodyOf(PAYERS, 'fn_pay_backed_payout_shortfalls');
    expect(settlesThroughObligations(legacySweep)).toBe(false);
  });
});

describe('the settle key names the tournament so the wallet resolver picks the right club', () => {
  it('fn_settle_tournament_obligation keys as tourney:<tournament_id>:obl:<obligation_id>:<paid_cents>', () => {
    const body = bodyOf(PAYERS, 'fn_settle_tournament_obligation');
    expect(body).toContain(
      "v_key := 'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':' || (round(v_ob.amount_paid * 100))::bigint::text;"
    );
    // The old shape resolved the wallet to the player's first-joined club.
    expect(body).not.toContain("v_key := 'obl:' ||");
  });

  it('the historical reconciler counted settle-path rows before the cutover removed it', () => {
    expect(bodyOf(PAYERS, 'fn_tournament_payout_reconcile')).toContain(
      "tpo.idempotency_key LIKE 'tourney:%:obl:%'"
    );
  });
});

describe('R3 is log-only: the trigger watches, it never refuses', () => {
  const logger = bodyOf(R3, 'fn_ca_money_path_log');

  it('fires AFTER INSERT on wallet_transactions for tournament categories', () => {
    expect(R3).toMatch(
      /CREATE TRIGGER trg_ca_money_path_log\s+AFTER INSERT ON public\.wallet_transactions/
    );
    expect(R3).toMatch(/'prize','bounty','refund','tournament_prize','tournament_refund'/);
    expect(R3).toMatch(/LIKE 'tourney%'/);
  });

  it('lets the settle path through and records everything else', () => {
    expect(logger).toContain("IF v_path = 'fn_settle_tournament_obligation' THEN");
    expect(logger).toContain('INSERT INTO public.ca_money_path_violations');
    expect(logger).toMatch(/'r3:' \|\| v_cat \|\| ':' \|\| to_char\(/);
  });

  it('cannot refuse: no RAISE EXCEPTION, every write wrapped in EXCEPTION WHEN OTHERS', () => {
    expect(logger).not.toMatch(/RAISE EXCEPTION/);
    expect((logger.match(/EXCEPTION WHEN OTHERS THEN/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(R3).toMatch(/SET LOCAL lock_timeout = '4s'/);
  });

  it('negative control: a refusing logger would fail this law', () => {
    const mutated = logger + "\n  RAISE EXCEPTION 'refused';";
    expect(mutated).toMatch(/RAISE EXCEPTION/);
    expect(logger).not.toMatch(/RAISE EXCEPTION/);
  });

  it('the table is service_role only with RLS on', () => {
    expect(R3).toContain('ALTER TABLE public.ca_money_path_violations ENABLE ROW LEVEL SECURITY');
    expect(R3).toContain(
      'REVOKE ALL ON TABLE public.ca_money_path_violations FROM PUBLIC, anon, authenticated'
    );
  });
});
