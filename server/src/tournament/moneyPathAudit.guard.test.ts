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
const MANAGER = code(read('src/tournament/TournamentManager.ts'));
const ELIM = code(read('src/tournament/TournamentManagerEliminations.ts'));

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
  /**
   * A migration REDEFINES the reconciler only when it carries a CREATE OR
   * REPLACE for it. A GRANT or REVOKE names the function too
   * (20260902203500_db_payers_state_their_grants.sql states who may call it
   * and defines nothing), and a grants-only file sorted last made this guard
   * read an empty body and report that exact-cent pricing had been dropped.
   * The question is "what does production RUN", so only definitions count.
   */
  const REDEFINES =
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_tournament_payout_reconcile\s*\(/i;

  it('the reconciler credits through fn_credit_and_log', () => {
    const files = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    // The LAST migration that redefines the reconciler is what production runs.
    const owning = files.filter((f) =>
      REDEFINES.test(sql(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')))
    );
    expect(owning.length, 'no migration defines the reconciler').toBeGreaterThan(0);

    const latest = sql(fs.readFileSync(path.join(MIGRATIONS, owning[owning.length - 1]), 'utf8'));
    // The original reconciler now delegates to the obligation writer. Verify
    // both executable calls so a money_path label or comment cannot pass.
    expect(latest).toMatch(/v_settle\s*:=\s*public\.fn_settle_tournament_obligation\s*\(/i);
    const settlementDefinitions = files.filter((file) =>
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_settle_tournament_obligation\s*\(/i.test(
        sql(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'))
      )
    );
    expect(settlementDefinitions.length, 'no obligation writer definition').toBeGreaterThan(0);
    const settlement = sql(
      fs.readFileSync(path.join(MIGRATIONS, settlementDefinitions.at(-1)!), 'utf8')
    );
    expect(settlement).toMatch(/v_credited\s*:=\s*public\.fn_credit_and_log\s*\(/i);
    for (const body of [latest, settlement]) {
      expect(body, 'bare credit can leave an unearned ledger row').not.toMatch(
        /(?:PERFORM|SELECT)\s+(?:public\.)?credit_player_wallet\s*\(/i
      );
    }
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
      REDEFINES.test(sql(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')))
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

describe('the recovery watchdog cannot pay money it has no right to', () => {
  it('tops up on its own obligation, not the one that already paid the place', () => {
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
     * 2026-08-29 fixed it with a `prizeadj` key carrying the AMOUNT. The chip
     * standard (2026-09-02) replaced that with an obligation of its own kind:
     * (tournament, 'late_reg_adjustment', N) is told the full amount OWED and
     * the database pays only the unpaid part. The top-up must settle THAT
     * kind, never 'place', and must pass `owed` (what is owed), not `diff`.
     */
    // RECOVERY is comment-stripped, so anchor on the step-3 loop's own guard.
    const topUp = RECOVERY.slice(RECOVERY.indexOf("if (r.status !== 'eliminated' || !r.position)"));
    expect(topUp).toMatch(/\{ kind: 'late_reg_adjustment', place: Number\(r\.position\) \}/);
    expect(topUp).toMatch(/await credit\(\s*r\.user_id,\s*owed,/);
    expect(topUp).not.toMatch(/prizeadj:/);
  });

  it('knows whether the credit actually moved chips', () => {
    // The RPC's `paid` (chips moved by THIS call) is the only signal
    // distinguishing "already done" from "just done", and the old boolean
    // was thrown away. The wrapper must return it, and must THROW on a
    // refusal rather than let the prize stamp below record a payment that
    // was refused.
    expect(RECOVERY).toMatch(/Promise<boolean>/);
    expect(RECOVERY).toMatch(/return res\.paid > 0;/);
    expect(RECOVERY).toMatch(/if \(!res\.ok\) \{\s*throw new Error/);
  });

  it('refuses to pay structure cash on a satellite', () => {
    // A satellite awards SEATS. Both live payout sites check this; recovery
    // did not, and paid cash under the same key processSatelliteAwards uses
    // for the ticket value -- a race between two different amounts.
    expect(RECOVERY).toMatch(/=== 'satellite'/);
    expect(RECOVERY).toMatch(/recoverStuckCompleting_satellite_skipped/);
  });

  it('refuses to pay over a final-table deal', () => {
    // settleFinalTableDeal pays under `tourney:{id}:ftd:{user}`, a namespace
    // recovery never writes, so nothing dedupes and its top-ups would be new
    // money on top of a deal the players negotiated.
    expect(RECOVERY).toMatch(/final_table_deal/);
    expect(RECOVERY).toMatch(/recoverStuckCompleting_chopped_skipped/);
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
    expect(MANAGER).toMatch(/satellite_target_unreadable/);
  });

  it('an unreadable finisher list does not become an empty field', () => {
    // An empty list returns early and leaves the entire pool undistributed.
    expect(MANAGER).toMatch(/satellite_finishers_unreadable/);
  });
});

describe('the prize pool and the structure it is priced by', () => {
  it('repricing happens even when the guarantee could not be funded', () => {
    /**
     * `prizePoolFinalized` is set before funding is attempted, and it is what
     * `finalFieldSize()` gates on -- so from that moment the structure is
     * trimmed to the field and the residual holder MOVES. Skipping the reprice
     * on a funding failure leaves places priced before and after that line
     * against different structures, with nothing reconciling them.
     */
    const base = code(read('src/tournament/TournamentManagerBase.ts'));
    expect(base).toMatch(/poolToPriceBy/);
    expect(base).toMatch(/recalculateEliminatedPrizes\(poolToPriceBy\)/);
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
