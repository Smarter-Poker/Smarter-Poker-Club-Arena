/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A BOUNTY POOL CANNOT PAY OUT MORE THAN IT HOLDS (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Found by a conservation check against production, not by reading code: eight
 * mystery bounty events in one afternoon paid MORE than their bounty pool.
 *
 *   Evening Mystery Bounty  pool 180.00  paid 191.00
 *   Union Mystery Bounty    pool 420.00  paid 459.00
 *   ...                     140.60 of chips minted in about four hours.
 *
 * Taking the 180.00 event apart: 30 entrants x 6.00 = 180.00 funded, and the
 * knockers received exactly 180.00 -- the whole pool, correctly, with
 * fn_collect_bounty's cap working. The champion was then paid 11.00 on top as
 * an "unclaimed" residual.
 *
 * fn_finalize_bounty_pool computed that residual as
 * `bounty_pool - bounty_pool_paid`, under a FOR UPDATE lock on `tournaments`.
 * The lock is real but it guards the wrong thing: `bounty_pool_paid` is a
 * COUNTER incremented by fn_collect_bounty as knockouts settle, and
 * finalisation runs while collections are still landing. It read a stale
 * 169.00, called 11.00 unclaimed, and paid it -- and the outstanding
 * collections then took the pool to 180.00 anyway.
 *
 * Worse, `bounty_pool_paid` was afterwards updated to match the overpayment,
 * so the counter and the ledger agreed at 191.00 and nothing objected.
 *
 * THE RULE: the residual is measured from the LEDGER. It is the only record
 * that cannot be stale relative to the money, because it IS the money.
 *
 * If this guard fails, someone has put the counter back. Do not "fix" it by
 * trusting bounty_pool_paid again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), '..', 'supabase', 'migrations');

/** Every migration that defines the finaliser, oldest first. */
function definitions(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    .filter((b) => b.includes('FUNCTION public.fn_finalize_bounty_pool'));
}

/** Strip SQL comments so a guard cannot pass on prose describing the old code. */
const sql = (s: string) => s.replace(/^\s*--.*$/gm, '');

describe('fn_finalize_bounty_pool', () => {
  it('is defined by at least one migration', () => {
    expect(definitions().length).toBeGreaterThan(0);
  });

  it('measures the residual from the ledger, not from bounty_pool_paid', () => {
    const defs = definitions();
    const latest = sql(defs[defs.length - 1]);

    // It must read the ledger...
    expect(latest, 'the finaliser no longer reads wallet_transactions').toMatch(
      /FROM wallet_transactions/
    );
    expect(latest).toMatch(/category = 'bounty'/);

    // ...and the residual must be pool minus what the LEDGER says, never the
    // counter. This is the exact line that minted 140.60.
    expect(
      latest,
      'the residual is being computed from bounty_pool_paid again - that is the overpayment'
    ).not.toMatch(
      /v_residual\s*:=\s*round\(\s*COALESCE\(v_t\.bounty_pool,\s*0\)\s*-\s*COALESCE\(v_t\.bounty_pool_paid/
    );
  });

  it('signs the ledger off type, because a debit is not a payment', () => {
    const defs = definitions();
    const latest = sql(defs[defs.length - 1]);
    expect(latest).toMatch(/lower\(wt\.type\) = 'debit'/);
  });

  it('never pays a negative or unfunded residual', () => {
    const defs = definitions();
    const latest = sql(defs[defs.length - 1]);
    expect(latest).toMatch(/IF v_residual <= 0/);
  });
});

describe('fn_collect_bounty', () => {
  /**
   * The finaliser fix alone was NOT enough, and production said so within five
   * hours: Saturday Mystery, pool 776.00, paid 783.20, with the last bounty
   * payment landing seven seconds after the event ended.
   *
   * There are TWO payers. fn_collect_bounty decided what was left with the
   * identical stale read the finaliser had just stopped using:
   *
   *     v_available := bounty_pool - bounty_pool_paid;
   *
   * FOR UPDATE on `tournaments` serialises the two against each other, so this
   * is not a classic lost update. It is simpler: a counter is only as good as
   * every writer keeping it current, and fixing one reader while the other
   * still trusts it just moves which payer overpays.
   *
   * Both now subtract the ledger from the pool. Whatever order collection and
   * finalisation run in, neither can hand out a chip the pool does not hold.
   */
  function collectDefinitions(): string[] {
    return fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      .filter((b) => b.includes('fn_collect_bounty'));
  }

  it('has a migration that moves it onto the ledger', () => {
    const defs = collectDefinitions().map(sql);
    expect(defs.length).toBeGreaterThan(0);
    const onLedger = defs.filter(
      (d) =>
        d.includes('INTO v_available FROM wallet_transactions') ||
        d.includes('FROM wallet_transactions wt')
    );
    expect(
      onLedger.length,
      'no migration moves fn_collect_bounty off the bounty_pool_paid counter'
    ).toBeGreaterThan(0);
  });

  it('the patch refuses to run blind rather than restating the whole function', () => {
    // Re-stating fn_collect_bounty in full would risk silently dropping the
    // hybrid tripwire, the mystery-phase handoff or the already-collected
    // dedupe. The migration patches one line and RAISEs if that line is not
    // where it expects, then asserts every guard survived.
    const defs = collectDefinitions();
    const patcher = defs.filter((d) => d.includes('refusing to patch blind'));
    expect(patcher.length).toBeGreaterThan(0);
    const latest = patcher[patcher.length - 1];
    for (const guard of [
      'bounty_pool_exhausted',
      'undefined_pko_mystery_hybrid',
      'mystery_phase_active',
      'already_collected',
    ]) {
      expect(latest, `the migration does not assert ${guard} survived`).toContain(guard);
    }
  });
});
