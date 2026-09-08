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
 * This law pins the migration that re-pointed them: every one of the six
 * bodies settles through fn_settle_tournament_obligation and none of them
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

const PAYERS = read('supabase/migrations/20260902201000_db_payers_settle_through_obligations.sql');
const R3 = read('supabase/migrations/20260902201500_r3_money_path_log_only.sql');
const AUTHORITATIVE = read(
  'supabase/migrations/20260908065210_tournament_cash_settlement_has_one_atomic_authority.sql'
);

const SIX = [
  'fn_tournament_payout_reconcile',
  'fn_pay_backed_payout_shortfalls',
  'fn_ca_backpay_guarantee_shortfalls',
  'fn_backpay_spin_unpaid_winners',
  'fn_backpay_hu_winner_shortfalls',
  'fn_final_table_deal',
] as const;

/** The body of one CREATE OR REPLACE FUNCTION in a migration file. */
function bodyOf(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) return '';
  const end = sql.indexOf('$function$;', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end);
}

function authoritativeCashBody(): string {
  const start = AUTHORITATIVE.indexOf(
    'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places('
  );
  expect(start, 'fn_settle_tournament_places must be defined').toBeGreaterThan(-1);
  const end = AUTHORITATIVE.indexOf('$settle_places$;', start);
  return AUTHORITATIVE.slice(start, end < 0 ? AUTHORITATIVE.length : end);
}

describe('the cash ladder settles through one authoritative database door', () => {
  const settle = authoritativeCashBody();

  it('derives the complete ladder behind the tournament and roster locks', () => {
    expect(settle).toContain('fn_ca_tournament_place_amounts');
    expect(settle).toMatch(/FROM public\.tournaments[\s\S]*FOR UPDATE/);
    expect(settle).toMatch(/FROM public\.tournament_players[\s\S]*FOR UPDATE/);
    expect(settle).toContain('fn_ca_settle_tournament_place_raw');
  });

  it('is the only new payout primitive granted to service_role', () => {
    expect(AUTHORITATIVE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_settle_tournament_places\(uuid,uuid\)[\s\S]*TO service_role;/
    );
    for (const ownerOnly of [
      'fn_ca_tournament_place_amounts',
      'fn_ca_settle_tournament_place_raw',
      'fn_credit_and_log',
    ]) {
      expect(AUTHORITATIVE).toMatch(
        new RegExp(
          `has_function_privilege\\('service_role',[\\s\\S]{0,180}?public\\.${ownerOnly}[\\s\\S]{0,180}?'EXECUTE'\\)`,
          'i'
        )
      );
    }
  });

  it('returns success only after every place and its evidence are proven', () => {
    expect(settle).toContain('post-settlement proof failed');
    expect(settle).toContain("'fully_settled',true");
    expect(settle.indexOf('post-settlement proof failed')).toBeLessThan(
      settle.indexOf("'fully_settled',true")
    );
  });
});

/** The predicate the law enforces, so the negative control tests the SAME rule.
 *  A payer settles through the obligation ledger either by calling the settle
 *  function itself or by handing distribution to the reconciler in apply mode
 *  (the two guarantee sweeps), and in neither case may it credit a wallet. */
const DELEGATES_TO_RECONCILER = /fn_tournament_payout_reconcile\([^)]*,\s*true\)/;
function settlesThroughObligations(body: string): boolean {
  return (
    (body.includes('fn_settle_tournament_obligation(') || DELEGATES_TO_RECONCILER.test(body)) &&
    !body.includes('fn_credit_and_log(') &&
    !body.includes('credit_player_wallet(')
  );
}

describe('every DB-side tournament payer settles through fn_settle_tournament_obligation', () => {
  it.each(SIX)('%s is redefined by the Lane A3 migration', (name) => {
    expect(bodyOf(PAYERS, name).length).toBeGreaterThan(0);
  });

  it.each(SIX)(
    '%s calls the settle function and never fn_credit_and_log / credit_player_wallet',
    (name) => {
      expect(settlesThroughObligations(bodyOf(PAYERS, name))).toBe(true);
    }
  );

  it('the two guarantee sweeps distribute through the reconciler, which is the settle path', () => {
    for (const name of ['fn_pay_backed_payout_shortfalls', 'fn_ca_backpay_guarantee_shortfalls']) {
      expect(bodyOf(PAYERS, name)).toMatch(/fn_tournament_payout_reconcile\([^)]*,\s*true\)/);
    }
  });

  it('the reconciler settles a place with its FULL entitlement, source reconcile', () => {
    const body = bodyOf(PAYERS, 'fn_tournament_payout_reconcile');
    expect(body).toMatch(
      /fn_settle_tournament_obligation\(\s*p_tournament_id, 'place', r\.place, v_holder, v_expected, 'reconcile'/
    );
    // A wallet paid with no payout record is reported, never settled again.
    expect(body).toContain("'paid_without_payout_record'");
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
    // A sweep that only DRY-RUNS the reconciler and then pays on its own key.
    const sweep = bodyOf(PAYERS, 'fn_pay_backed_payout_shortfalls');
    expect(settlesThroughObligations(sweep)).toBe(true);
    const dryOnly = sweep.replace(
      /fn_tournament_payout_reconcile\(r\.id, true\)/g,
      'fn_tournament_payout_reconcile(r.id, false)'
    );
    expect(settlesThroughObligations(dryOnly)).toBe(false);
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

  it('the reconciler counts settle-path rows as prize-pool money whatever their source label', () => {
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
