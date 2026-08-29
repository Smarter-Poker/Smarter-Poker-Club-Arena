/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MONEY-PATH AUDIT — the findings from 2026-08-29, pinned
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-29: "CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS,
 * REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE. MAKE SURE THAT NOTHING
 * EVER BREAKS AND IS ALWAYS 10000% ACCURATE AND CORRECT."
 *
 * Each guard below is a defect that was live in production that day. They are
 * source guards because every one of them lives behind a supabase round-trip
 * and cannot be reached in a unit test without one. Each names what it
 * prevents, so a future reader can decide whether the rule still applies
 * rather than deleting a test they do not understand.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
/** Strip comments so a guard cannot pass on prose describing the old code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
/** Strip SQL line comments, for the same reason. */
const sql = (src: string) => src.replace(/^\s*--.*$/gm, '');

const BASE = code(read('src/tournament/TournamentManagerBase.ts'));
const RECOVERY = code(read('src/tournament/tournamentRecovery.ts'));

describe('a column that is read is a column that is selected', () => {
  it('mystery_bounty_top_percent is in the query that reads it', () => {
    /**
     * It was READ -- `fresh.mystery_bounty_top_percent == null ? DEFAULT : ...`
     * -- fourteen lines below a select list that did not contain it. PostgREST
     * returns only what is asked for, `undefined == null` is true, so EVERY
     * mystery bounty event built its chest at the 20% default no matter what
     * the host configured. The column is real, is written through a validated
     * RPC, and the spec file claims this exact defect was already fixed: it
     * was fixed in the arithmetic and never wired to the query.
     *
     * On a 25,000 mystery pool configured at 30%, the lobby advertises a
     * 7,500 headline prize and the chest holds 5,000.
     */
    const reads = BASE.includes('fresh.mystery_bounty_top_percent');
    expect(reads, 'the read moved; re-point this guard').toBe(true);
    expect(
      BASE,
      'mystery_bounty_top_percent is read but not selected — it will always be undefined'
    ).toMatch(/select\([\s\S]{0,600}?mystery_bounty_top_percent/);
  });
});

describe('the stuck-tournament watchdog', () => {
  it('treats a winner row as holding its finishing place', () => {
    /**
     * The collision map tested `status === 'eliminated'` only, and
     * finishTournament stamps the champion `status: 'winner', position: 1`.
     * A process that died between that stamp and the COMPLETED flip -- the
     * exact window this watchdog exists for -- left the winner invisible, so
     * place 1 read as free and the lone survivor was handed it.
     *
     * Nobody is paid twice (the place-scoped idempotency key stops that), and
     * that is what makes it nasty: the survivor is stamped 'winner' with first
     * prize and receives NOTHING, while the place they actually finished in is
     * never paid to anybody.
     */
    expect(RECOVERY).toMatch(/r\.status === 'eliminated' \|\| r\.status === 'winner'/);
  });
});

describe('no money path writes a ledger row it did not earn', () => {
  /**
   * `credit_player_wallet` returns void and dedupes silently, so pairing it
   * with an unconditional `log_wallet_transaction` writes a ledger row for a
   * credit that moved nothing. Migration 20260822190000 abolished that pair
   * after it produced 95 phantom prize rows worth 7,446.45 chips.
   *
   * It matters more than a cosmetic double entry: fn_tournament_payout_reconcile
   * measures what a player has been paid by SUMMING wallet_transactions, so a
   * phantom row makes a real shortfall permanently invisible to the only
   * automated net there is. `fn_credit_and_log` returns boolean and writes the
   * row only when the credit actually landed.
   */
  const MIGRATIONS = path.join(process.cwd(), '..', 'supabase', 'migrations');

  it('the reconciler credits through fn_credit_and_log', () => {
    const files = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    // The LAST migration that redefines the reconciler is what production runs.
    const owning = files.filter((f) =>
      fs
        .readFileSync(path.join(MIGRATIONS, f), 'utf8')
        .includes('FUNCTION public.fn_tournament_payout_reconcile')
    );
    expect(owning.length, 'no migration defines the reconciler').toBeGreaterThan(0);

    const latest = sql(fs.readFileSync(path.join(MIGRATIONS, owning[owning.length - 1]), 'utf8'));
    expect(latest, `${owning[owning.length - 1]} must credit through fn_credit_and_log`).toMatch(
      /fn_credit_and_log/
    );
    expect(
      latest,
      `${owning[owning.length - 1]} still uses the bare credit + unconditional log pair`
    ).not.toMatch(/PERFORM credit_player_wallet\(/);
  });

  it('the last-written reconciler keeps the exact-cent pricing', () => {
    /**
     * Two migrations written on 2026-08-29 both redefined this function -- one
     * added exact integer-cent pricing, the other added the prize stamp -- and
     * the second sorted AFTER the first, so a replay would have silently
     * reverted exactness. That is the regression this guard exists to catch:
     * whoever redefines the reconciler next must carry every fix forward.
     */
    const files = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const owning = files.filter((f) =>
      fs
        .readFileSync(path.join(MIGRATIONS, f), 'utf8')
        .includes('FUNCTION public.fn_tournament_payout_reconcile')
    );
    const latest = sql(fs.readFileSync(path.join(MIGRATIONS, owning[owning.length - 1]), 'utf8'));

    expect(latest, 'exact-cent pricing was dropped by a later redefinition').toMatch(
      /v_pool_cents/
    );
    expect(latest, 'the prize stamp was dropped by a later redefinition').toMatch(
      /SET prize = v_expected/
    );
  });
});
