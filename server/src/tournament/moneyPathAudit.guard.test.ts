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
const RECOVERY_RAW = read('src/tournament/tournamentRecovery.ts');
const RECOVERY_SOURCE = code(RECOVERY_RAW);
const RECOVERY = RECOVERY_SOURCE.slice(
  RECOVERY_SOURCE.indexOf('export async function recoverStuckCompletingTournaments')
);
const SATELLITE_RECOVERY = code(
  RECOVERY_RAW.slice(
    RECOVERY_RAW.indexOf(
      "String((t as { variant?: string }).variant ?? '').toLowerCase() === 'satellite'"
    ),
    RECOVERY_RAW.indexOf('// A COMPLETING cash event is resumable')
  )
);
const MANAGER = code(read('src/tournament/TournamentManager.ts'));
const ELIM = code(read('src/tournament/TournamentManagerEliminations.ts'));
const COMPLETION_RECEIPT = code(read('src/tournament/completionSettlementReceipt.ts'));
const TERMINAL_RPC = code(read('src/tournament/terminalSettlementRpc.ts'));
const SATELLITE_RPC = code(read('src/tournament/satelliteSettlementRpc.ts'));
const MIGRATIONS = path.join(process.cwd(), '..', 'supabase', 'migrations');

const atomicSatelliteSql = (): string => {
  const owning = fs
    .readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) =>
      sql(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8')).includes(
        'CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament('
      )
    );
  expect(owning.length, 'no atomic satellite settlement definition').toBeGreaterThan(0);
  return sql(fs.readFileSync(path.join(MIGRATIONS, owning.at(-1)!), 'utf8'));
};

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
  it('requires one durable champion and cannot rank a replacement', () => {
    expect(RECOVERY).toMatch(/player\.status === 'winner' && Number\(player\.position\) === 1/);
    expect(RECOVERY).toMatch(/durableChampions\.length !== 1 \|\| otherFirstPlaces\.length > 0/);
    expect(RECOVERY).toMatch(/recoverStuckCompleting_durable_winner_absent/);
    expect(RECOVERY).not.toMatch(/\.sort\(\(a, b\) => Number\(b\.chips/);
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

  it('the rolling cutover preserves the reconciler without making it an engine path', () => {
    const files = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const owning = files.filter((f) =>
      REDEFINES.test(sql(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')))
    );
    expect(owning.length, 'no migration defines the reconciler').toBeGreaterThan(0);
    const latest = sql(fs.readFileSync(path.join(MIGRATIONS, owning.at(-1)!), 'utf8'));
    const atomicCash = sql(
      fs.readFileSync(
        path.join(
          MIGRATIONS,
          '20260908065210_tournament_cash_settlement_has_one_atomic_authority.sql'
        ),
        'utf8'
      )
    );
    expect(latest).toMatch(/v_settle\s*:=\s*public\.fn_settle_tournament_obligation\s*\(/i);
    expect(latest, 'bare credit can leave an unearned ledger row').not.toMatch(
      /(?:PERFORM|SELECT)\s+(?:public\.)?credit_player_wallet\s*\(/i
    );
    expect(atomicCash).not.toMatch(REDEFINES);
    expect(atomicCash).not.toMatch(
      /DROP FUNCTION(?: IF EXISTS)? public\.fn_tournament_payout_reconcile/
    );
    expect(MANAGER).not.toMatch(/fn_tournament_payout_reconcile/);
    expect(ELIM).not.toMatch(/fn_tournament_payout_reconcile/);
    expect(RECOVERY).not.toMatch(/fn_tournament_payout_reconcile/);

    // The compatibility function and the atomic authority both delegate to
    // the same owner plumbing, which keeps credit and evidence inseparable.
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
    expect(settlement, 'bare credit can leave an unearned ledger row').not.toMatch(
      /(?:PERFORM|SELECT)\s+(?:public\.)?credit_player_wallet\s*\(/i
    );
  });

  it('the atomic cash authority owns exact-cent pricing without a later observer', () => {
    /**
     * Two migrations written on 2026-08-29 both redefined this function -- one
     * added exact integer-cent pricing, the other added the prize stamp -- and
     * the second sorted AFTER the first, so a replay would have silently
     * reverted exactness. That is the regression this guard exists to catch:
     * whoever redefines the reconciler next must carry every fix forward.
     */
    const core = sql(
      fs.readFileSync(
        path.join(
          MIGRATIONS,
          '20260908065210_tournament_cash_settlement_has_one_atomic_authority.sql'
        ),
        'utf8'
      )
    );
    expect(core).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_tournament_place_amounts\s*\(/);
    expect(core).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_settle_tournament_places\([\s\S]*?fn_ca_tournament_place_amounts\s*\(/
    );
    expect(core).not.toMatch(REDEFINES);
  });
});

describe('the recovery watchdog cannot pay money it has no right to', () => {
  it('has no per-player credit, top-up, or payout formula', () => {
    expect(RECOVERY).not.toMatch(/settleTournamentObligation/);
    expect(RECOVERY).not.toMatch(/late_reg_adjustment|computePlacePrize|resolvePayoutStructure/);
    expect(RECOVERY).not.toMatch(/for \(let i = 0; i < alive\.length/);
  });

  it('calls only the terminal domain authority and checks transport failure', () => {
    expect(RECOVERY).toMatch(/isFinalTableDeal[\s\S]*settlementMode/);
    expect(RECOVERY).toMatch(/requestTournamentTerminalReceipt\(t\.id, settlementMode, winnerId\)/);
    expect(RECOVERY).not.toMatch(/rpc\(\s*'fn_settle_tournament_(?:places|final_table_deal|rake)'/);
    expect(TERMINAL_RPC).toMatch(/rpc\('fn_complete_tournament_terminal'/);
    expect(TERMINAL_RPC).toMatch(/TerminalSettlementOutcomeUnknownError/);
    expect(TERMINAL_RPC).toMatch(/TerminalSettlementRefusedError/);
  });

  it('routes a decided satellite only through its whole-event authority', () => {
    expect(RECOVERY).toMatch(/=== 'satellite'/);
    expect(SATELLITE_RECOVERY).toMatch(/requestSatelliteSettlementReceipt/);
    expect(SATELLITE_RPC).toMatch(/fn_settle_satellite_tournament/);
    expect(SATELLITE_RPC).toMatch(/verifySatelliteSettlementReceipt/);
    expect(SATELLITE_RECOVERY).toMatch(/Satellite\.seat_outcome_unconfirmed/);
    expect(SATELLITE_RECOVERY).not.toMatch(/from\('tournament_payouts'\)/);
    expect(SATELLITE_RECOVERY).not.toMatch(/source_satellite_id|alreadyAwarded/);
    expect(SATELLITE_RECOVERY).not.toMatch(/status:\s*'COMPLETED'/);
  });

  it('accepts only a complete, internally consistent settlement receipt', () => {
    expect(TERMINAL_RPC).toMatch(/verifyTournamentCompletionReceipt\(/);
    expect(COMPLETION_RECEIPT).toMatch(/receipt\.status !== 'COMPLETED'/);
    expect(COMPLETION_RECEIPT).toMatch(/users\.has\(userId\)/);
    expect(COMPLETION_RECEIPT).toMatch(/places\.has\(place\)/);
    expect(COMPLETION_RECEIPT).toMatch(/payout\.place === 1 && payout\.userId === winnerId/);
    expect(TERMINAL_RPC).toMatch(/terminal settlement returned an invalid stored receipt/);
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
    const authority = atomicSatelliteSql();
    expect(authority).toContain('target % is missing without a published contract');
    expect(authority).toContain('target % admission state % is ambiguous');
    expect(authority).toContain('target has an invalid whole-cent entry contract');
  });

  it('an unreadable finisher list does not become an empty field', () => {
    // An empty list returns early and leaves the entire pool undistributed.
    const authority = atomicSatelliteSql();
    expect(authority).toContain('satellite % has no final field');
    expect(authority).toContain('has no complete durable elimination sequence');
    expect(authority).toContain('could not prove contiguous final standings');
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
