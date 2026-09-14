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
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
/** Strip comments so a guard cannot pass on prose describing the old code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
/** Strip SQL line comments, for the same reason. */
const sql = (src: string) => src.replace(/^\s*--.*$/gm, '');

const BASE = code(read('src/tournament/TournamentManagerBase.ts'));
const RECOVERY = code(read('src/tournament/tournamentRecovery.ts'));
const ELIM = code(read('src/tournament/TournamentManagerEliminations.ts'));
const TERMINAL_RPC = code(read('src/tournament/terminalSettlementRpc.ts'));
const RECEIPT_VERIFIER = code(read('src/tournament/completionSettlementReceipt.ts'));
const MIGRATIONS = path.join(process.cwd(), '..', 'supabase', 'migrations');
const migrationNames = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));
const cashSettlementName = migrationNames.find((name) =>
  name.includes('tournament_cash_settlement_has_one_atomic_authority')
);
const terminalSettlementName = migrationNames.find((name) =>
  name.includes('non_satellite_terminal_settlement_commits_one_stored_receipt')
);
if (!cashSettlementName || !terminalSettlementName) {
  throw new Error('current cash/terminal settlement migrations are missing');
}
const CASH_SETTLEMENT = sql(read(`../supabase/migrations/${cashSettlementName}`));
const TERMINAL_SETTLEMENT = sql(read(`../supabase/migrations/${terminalSettlementName}`));
const LATE_REG = sql(
  read('../supabase/migrations/20260908042200_late_registration_can_build_its_first_table.sql')
);
const ATOMIC_SATELLITE = sql(
  read(
    '../supabase/migrations/20260908042300_a_satellite_finish_pays_one_frozen_entitlement_plan.sql'
  )
);

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
      'mystery_bounty_top_percent is read but not selected - it will always be undefined'
    ).toMatch(/select\([\s\S]{0,600}?mystery_bounty_top_percent/);
  });
});

describe('the stuck-tournament watchdog', () => {
  it('accepts one winner row and refuses duplicate winner witnesses', () => {
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
    const ranker = RECOVERY.slice(
      RECOVERY.indexOf('function canonicalWinner('),
      RECOVERY.indexOf('async function readRecoveryField(')
    );
    expect(ranker).toMatch(/row\.status === 'winner' && Number\(row\.position\) === 1/);
    expect(ranker).toMatch(/if \(winners\.length === 1\) return winners\[0\]\.user_id/);
    expect(ranker).toMatch(/if \(winners\.length > 1\) return null/);
    expect(ranker).toMatch(/eliminated\.length !== rows\.length/);
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
  it('the terminal authority accepts payout evidence only with its exact wallet identity', () => {
    expect(CASH_SETTLEMENT).toMatch(
      /p\.idempotency_key IS NULL OR NOT EXISTS \([\s\S]*?FROM public\.wallet_credit_idempotency k[\s\S]*?k\.key = p\.idempotency_key[\s\S]*?k\.user_id = p\.user_id[\s\S]*?k\.amount = p\.amount/
    );
    const finish = sliceMethod(ELIM, 'finishTournament(winnerId: string): Promise<void>');
    const recovery = sliceMethod(
      RECOVERY,
      'export async function recoverStuckCompletingTournaments('
    );
    for (const source of [finish, recovery]) {
      expect(source).not.toMatch(/credit_player_wallet|log_wallet_transaction|wallet_transactions/);
      expect(source).not.toMatch(/settleTournamentObligation|fn_settle_tournament_obligation/);
    }
  });

  it('the terminal ladder remains exact-cent and its receipt must conserve the total', () => {
    expect(CASH_SETTLEMENT).toMatch(/fn_ca_tournament_place_amounts/);
    expect(CASH_SETTLEMENT).toMatch(/IS DISTINCT FROM round\(v_amount,2\)/);
    expect(CASH_SETTLEMENT).toMatch(/SET prize = v_row\.amount/);
    expect(RECEIPT_VERIFIER).toMatch(/payoutCents !== Math\.round\(cashPayoutTotal \* 100\)/);
    expect(TERMINAL_SETTLEMENT).toMatch(
      /SET status = 'COMPLETED'[\s\S]*?INSERT INTO public\.tournament_terminal_settlements/
    );
  });
});

describe('the recovery watchdog cannot pay money it has no right to', () => {
  it('has one whole-event receipt door per format and no fragment writer', () => {
    /**
     * The ITM top-up used `tourney:{id}:prize:place:{N}` -- the key
     * eliminatePlayer already paid that place under. The comment said "recorded
     * with a zero prize" but the condition is `owed > recorded`, so it also
     * fires on a PARTIAL shortfall: the pool grew, more is owed, and the
     * smaller amount has already been paid under that key. The credit deduped
     * to nothing, the boolean was discarded, and the next statement stamped
     * `prize = owed` -- a payment recorded that never happened, invisible to
     * every later pass.
     *
     * Per-place recovery was still a split transaction: an early place could
     * commit before a later place refused. Recovery now stamps the final
     * entitlement only; the atomic helper prepares the complete obligation
     * fingerprint and either settles every place plus COMPLETED or none.
     */
    const recovery = sliceMethod(
      RECOVERY,
      'export async function recoverStuckCompletingTournaments('
    );
    expect(recovery.match(/requestTournamentTerminalReceipt\(/g)).toHaveLength(1);
    expect(recovery.match(/requestSatelliteSettlementReceipt\(/g)).toHaveLength(1);
    expect(recovery).not.toMatch(
      /settleTournamentPlacesAtomically|settleTournamentObligation|fn_settle_tournament_obligation/
    );
    expect(recovery).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it('reports recovery success only after the receipt helper returns', () => {
    const recovery = sliceMethod(
      RECOVERY,
      'export async function recoverStuckCompletingTournaments('
    );
    const request = recovery.indexOf('const receipt = await requestTournamentTerminalReceipt(');
    const success = recovery.indexOf('[GameServer] Recovered tournament', request);
    const refusal = recovery.indexOf('error instanceof TerminalSettlementRefusedError', success);
    const unknown = recovery.indexOf('reportUnknownRecoveryOutcome(', refusal);
    expect(request).toBeGreaterThanOrEqual(0);
    expect(success).toBeGreaterThan(request);
    expect(refusal).toBeGreaterThan(success);
    expect(unknown).toBeGreaterThan(refusal);
    expect(TERMINAL_RPC).toMatch(/verifyTournamentCompletionReceipt\(/);
    expect(TERMINAL_RPC).toMatch(/fn_resolve_tournament_terminal_outcome/);
  });

  it('refuses to pay structure cash on a satellite', () => {
    // A satellite awards SEATS. Both live payout sites check this; recovery
    // did not, and paid cash under the same key processSatelliteAwards uses
    // for the ticket value -- a race between two different amounts.
    const recovery = sliceMethod(
      RECOVERY,
      'export async function recoverStuckCompletingTournaments('
    );
    const branch = recovery.slice(
      recovery.indexOf('if (isSatellite)'),
      recovery.indexOf('const [dealPayouts, dealObligations]')
    );
    expect(branch).toMatch(/requestSatelliteSettlementReceipt\(tournament\.id, winnerId\)/);
    expect(branch).toMatch(/continue;/);
    expect(branch).not.toMatch(/requestTournamentTerminalReceipt|resolvePayoutStructure/);
  });

  it('refuses to pay over a final-table deal', () => {
    // Recovery recognizes the durable deal receipt and re-drives only those
    // exact idempotent deal obligations. It never falls through to structure
    // cash, which would pay new money over the negotiated shares.
    const recovery = sliceMethod(
      RECOVERY,
      'export async function recoverStuckCompletingTournaments('
    );
    const evidence = recovery.indexOf('const hasDeal =');
    const winner = recovery.indexOf('let winnerId: string | null = null', evidence);
    const ordinaryRanking = recovery.indexOf('if (!hasDeal)', winner);
    const receipt = recovery.indexOf("hasDeal ? 'final_table_deal' : 'places'", ordinaryRanking);
    expect(evidence).toBeGreaterThanOrEqual(0);
    expect(winner).toBeGreaterThan(evidence);
    expect(ordinaryRanking).toBeGreaterThan(winner);
    expect(receipt).toBeGreaterThan(ordinaryRanking);
    expect(recovery.slice(winner, ordinaryRanking)).toContain('winnerId: string | null = null');
    expect(recovery).not.toMatch(/settleTournamentPlacesAtomically|\.update\(\{ prize:/);
  });
});

describe('satellites decide on reads that succeeded', () => {
  it('an unreadable target does not become a cash payout', () => {
    /**
     * The error was discarded, so a failed read looked like "no target": that
     * drives ticketCost to 0, seats to 0, and pays the WHOLE POOL as cash to
     * one player instead of awarding N seats. The event then completes, so
     * there is nothing left to retry.
     */
    expect(ATOMIC_SATELLITE).toContain("'frozen_target_missing'");
    expect(ATOMIC_SATELLITE).toMatch(
      /SELECT \* INTO v_target[\s\S]*?IF NOT FOUND THEN[\s\S]*?frozen_target_missing/
    );
  });

  it('an unreadable finisher list does not become an empty field', () => {
    // The atomic finalizer locks and proves a complete contiguous terminal
    // standings set before it is allowed to pay or flip COMPLETED.
    expect(ATOMIC_SATELLITE).toContain("'satellite_standings_not_terminal'");
    expect(ATOMIC_SATELLITE).toMatch(/v_terminal_count<>v_player_count/);
    expect(ATOMIC_SATELLITE).toMatch(/v_ranked_count<>v_player_count/);
  });
});

describe('the prize pool and the structure it is priced by', () => {
  it('entry close cannot finalize without funding and cannot lose its reprice', () => {
    /**
     * The database now fits the final field and funds the guarantee inside the
     * same row-locked transaction; a funding refusal rolls the close back.
     * Its durable receipt remains pending across response loss or process
     * death until the exact eliminated-player reprice is database-proven.
     */
    const finalize = LATE_REG.slice(
      LATE_REG.indexOf('FUNCTION public.fn_finalize_tournament_entry_pool_locked'),
      LATE_REG.indexOf('FUNCTION public.fn_close_tournament_entry_window')
    );
    expect(finalize).toMatch(/fn_ca_payout_structure/);
    expect(finalize).toMatch(/fn_apply_prize_guarantee/);
    expect(finalize).toMatch(/INSERT INTO public\.tournament_entry_close_receipts/);
    expect(finalize.indexOf('fn_ca_payout_structure')).toBeLessThan(
      finalize.indexOf('fn_apply_prize_guarantee')
    );
    expect(finalize.indexOf('fn_apply_prize_guarantee')).toBeLessThan(
      finalize.indexOf('INSERT INTO public.tournament_entry_close_receipts')
    );
    expect(BASE).toMatch(/recalculateEliminatedPrizes\(finalPool\)/);
    expect(BASE).toMatch(/fn_complete_tournament_entry_reprice/);
  });

  it('nothing rewrites the stored payout structure at start', () => {
    /**
     * It truncated in binary floats, dumped the remainder on `payouts[0]` (the
     * first ARRAY element, and a headline prize either way -- the opposite of
     * the payout law), and discarded the write error, leaving the cache and
     * the column holding different structures. computePlacePrize already
     * normalises by the structure's own total, exactly, so it bought nothing.
     */
    const base = code(read('src/tournament/TournamentManagerBase.ts'));
    expect(base).not.toMatch(/update\(\{ payout_structure: payouts \}\)/);
    expect(base).not.toMatch(/payouts\[0\]\.percentage =/);
  });
});

describe('a split pot is never settled silently', () => {
  it('passes every claimant into the bounty split (ruling 2026-08-31)', () => {
    // The ruling landed with zero-drift phase 5: a tied pot splits the bounty
    // BY CLAIM WEIGHT inside fn_collect_bounty (cents, largest remainder,
    // conserving). The engine must hand the claimant list over, and a split
    // must still announce itself in the log. The old single-collector audit
    // marker is gone because the defect it measured is gone.
    expect(ELIM).toMatch(/p_claimants: claimants\.map/);
    expect(ELIM).toMatch(/Split-pot knockout/);
    expect(ELIM).not.toMatch(/split_pot_bounty_paid_to_one/);
  });
});
