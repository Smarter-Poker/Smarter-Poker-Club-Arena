/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RECONCILER TRUSTS WHAT IT CAN PROVE (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_tournament_payout_reconcile answers one question per finishing place:
 * "what has this player already been paid?" It used to answer it by summing
 * `wallet_transactions`. That is a LOG — written after the money moves, by a
 * separate statement — and it can be missing, or present for a credit that
 * never moved.
 *
 * Mid-Morning Turbo (6-Max NLH) 88a6aced, 2026-08-22, measured:
 *
 *   14:14:06  the credit MOVED (idempotency key `...:prize:{user}:4`, 36.90)
 *             and no wallet_transactions row was written for it
 *   14:29:55  the reconciler read 0.00 already paid and paid 36.90 AGAIN
 *
 * 73.80 for a place worth 36.90; the event disbursed 110% of its pool.
 * Morning Grinder (PLO) b687e4aa did the same on place 1 for 96.00 vs 48.00.
 *
 * `tournament_payouts.idempotency_key` is UNIQUE and its row is written inside
 * fn_credit_and_log only after the credit returned true, so one row exists if
 * and only if money moved once. These pins keep the reconciler pointed at it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');

const migration = (needle: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(needle));
  if (!file) throw new Error(`no migration matching "${needle}" - was it renamed?`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

/** Executable SQL only — `--` comment lines stripped. */
const executable = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const RECONCILER = () => executable(migration('the_reconciler_counts_payouts_not_ledger_rows'));

/**
 * Money the PRIZE POOL is meant to fund. Bounty money carries
 * `category = 'prize'` in the ledger while being funded from the bounty pool,
 * which is why the old ledger sum counted it and could call a player square
 * when the structure still owed them.
 */
const PRIZE_POOL_SOURCES = [
  'structure',
  'reconcile',
  'hu_shortfall',
  'late_reg_adjustment',
  'clawback',
  'final_table_deal',
  'spin_backpay',
];

const BOUNTY_POOL_SOURCES = ['bounty', 'own_bounty', 'mystery_bounty', 'mystery_bounty_residual'];

describe('the reconciler asks the authoritative record, not the log', () => {
  it('reads already-paid from tournament_payouts', () => {
    const sql = RECONCILER();
    expect(sql).toMatch(/FROM public\.tournament_payouts tpo/);
    expect(sql).toMatch(/INTO v_paid[\s\S]{0,400}FROM public\.tournament_payouts tpo/);
  });

  it('counts only money the prize pool funds', () => {
    const sql = RECONCILER();
    for (const s of PRIZE_POOL_SOURCES) {
      expect(sql, `${s} counts toward the structure`).toContain(`'${s}'`);
    }
  });

  it('never counts bounty money as structure money already paid', () => {
    // The whole point of the source filter. If one of these appears in the
    // reconciler's IN list, a PKO player's bounty winnings start paying down
    // what the prize pool owes them.
    const inList = (RECONCILER().match(/AND tpo\.source IN \(([\s\S]*?)\)/) ?? [])[1] ?? '';
    expect(inList.length, 'the source filter must exist at all').toBeGreaterThan(0);
    for (const s of BOUNTY_POOL_SOURCES) {
      expect(inList, `${s} must NOT count as structure money`).not.toContain(`'${s}'`);
    }
  });
});

describe('a missing record is not read as "nothing was paid"', () => {
  it('keeps the ledger arm as an explicit fallback', () => {
    const sql = RECONCILER();
    expect(sql).toContain('v_has_record');
    expect(sql).toMatch(/IF v_has_record THEN/);
    expect(sql).toMatch(/ELSE[\s\S]{0,600}FROM wallet_transactions wt/);
  });

  it('says which source answered, so a reader can tell', () => {
    const sql = RECONCILER();
    expect(sql).toContain("'paid_from'");
    expect(sql).toContain("'payout_record'");
    expect(sql).toContain("'ledger_fallback'");
  });
});

describe('the stance on money is unchanged', () => {
  const sql = () => RECONCILER();

  it('still reports an overpayment rather than clawing it back', () => {
    expect(sql()).toContain("'issue', 'overpaid'");
    expect(sql()).toContain('automatic clawback is deliberately not done');
  });

  it('still refuses to guess when a place has no single finisher', () => {
    expect(sql()).toContain("'no_finisher_recorded'");
    expect(sql()).toContain("'duplicate_finishers'");
  });

  it('still tops up under the place-scoped reconcile key, which bounds it to once', () => {
    // This is why the one measured case where the record reads LOWER than the
    // ledger (0.31 chips) cannot double-pay: that place's reconcile key is
    // already consumed, so fn_credit_and_log returns false and the shortfall
    // is reported instead of paid.
    expect(sql()).toMatch(/':reconcile'/);
    expect(sql()).toContain("'top_up_refused_by_idempotency'");
  });

  it('is not executable by a browser role', () => {
    expect(sql()).toContain(
      'REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)'
    );
    expect(sql()).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql()).toContain('TO service_role');
  });
});
