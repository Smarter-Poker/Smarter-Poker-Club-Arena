/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ELIMINATION SWEEP COULD NOT REACH THE TABLE (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured on production 2026-09-09 at 00:45 UTC: 285 of 390 RUNNING
 * tournaments had not dealt in twenty minutes and ZERO had completed in twelve,
 * on a platform that normally finishes hundreds an hour. The engine's own
 * ghost-seat detector said it 433 times in fifteen minutes - "the elimination
 * sweep is not reaching this table" - and 907 knockout candidates sat `pending`
 * for over two hours behind it.
 *
 * Nobody was hurt: every stalled seat was a horse, `fn_unaccounted_seat_exits()`
 * returned zero rows for all time, and no wallet went negative. What was lost
 * was a tournament's ability to END.
 *
 * Four causes. Two are in Postgres and ship in
 * `20260909005925_a_busted_player_without_a_seat_can_still_be_eliminated.sql`.
 * The two pinned here are in this process, and each one is a way for the sweep
 * to make no progress for ever while looking busy.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const ELIM = SRC('./TournamentManagerEliminations.ts');
const BASE = SRC('./TournamentManagerBase.ts');

describe('the busted batch is taken before the RPC that caps its input', () => {
  /**
   * `fn_open_tournament_rebuy_decisions` raises `invalid rebuy-decision
   * candidate set` for `cardinality(p_user_ids) > 50`. The whole `busted` array
   * was passed to it, and the SWEEP_MUTATION_BATCH_SIZE slice that bounds this
   * stage did not happen until forty lines later. Any tournament that reached
   * fifty-one concurrent zero-chip `playing` players therefore raised inside the
   * RPC on every pass, eliminated nobody, and came back with a list that could
   * only have grown. Three live tournaments held 609 stuck rows this way.
   */
  it('slices to the mutation batch before tryTournamentRebuys and the decision RPC', () => {
    const sliceAt = ELIM.indexOf('bustedTotal = busted.length');
    const rebuysAt = ELIM.indexOf('await this.tryTournamentRebuys(');
    const decisionsAt = ELIM.indexOf("'fn_open_tournament_rebuy_decisions'");
    expect(sliceAt, 'the batch bound must exist').toBeGreaterThan(0);
    expect(rebuysAt).toBeGreaterThan(sliceAt);
    expect(decisionsAt).toBeGreaterThan(sliceAt);
  });

  it('the slice is bounded by SWEEP_MUTATION_BATCH_SIZE, which is under the RPC cap of 50', () => {
    const block = ELIM.slice(
      ELIM.indexOf('const bustedTotal = busted.length'),
      ELIM.indexOf('await this.tryTournamentRebuys(')
    );
    expect(block).toMatch(/busted\.length > TournamentManagerBase\.SWEEP_MUTATION_BATCH_SIZE/);
    expect(block).toMatch(/\.slice\(0, TournamentManagerBase\.SWEEP_MUTATION_BATCH_SIZE\)/);
    expect(block).toMatch(/bustBatchHasMore = true/);
    // Read the constant from source rather than importing the module: this file
    // is a static pin and must not drag the engine's whole graph in with it.
    const declared = BASE.match(/SWEEP_MUTATION_BATCH_SIZE\s*=\s*(\d+)/);
    expect(declared, 'SWEEP_MUTATION_BATCH_SIZE must be declared').toBeTruthy();
    expect(Number(declared![1])).toBeLessThanOrEqual(50);
    expect(Number(declared![1])).toBeGreaterThan(0);
  });

  it('the whole-field spare-the-top-stack rule reads the total, not the slice', () => {
    // `playingCount === busted.length` would stop matching the moment the batch
    // narrowed the pass, and the guard exists to stop place 1 being paid twice.
    expect(ELIM).toMatch(/if \(playingCount === bustedTotal && bustedOrdered\.length > 0\)/);
    expect(ELIM).not.toMatch(/if \(playingCount === busted\.length && bustedOrdered\.length > 0\)/);
  });
});

describe('a refusal cannot corrupt the global bust order', () => {
  /**
   * The assignment loop aborts the pass on a refusal, and it must - a refusal
   * can mean the CAS missed because another generation took the place, and
   * handing out a stale place is how two players get paid for one finish. But
   * every candidate holds ZERO chips, so the old chip sort was a tie. The
   * accepted hand now supplies the exact order; retry rotation is permitted
   * only after hand number and hand-start stack are both tied.
   */
  it('records who refused without allowing a later hand to pass it', () => {
    expect(ELIM).toMatch(/private readonly bustRefusalStreak = new Map<string, number>\(\)/);
    const loop = ELIM.slice(
      ELIM.indexOf('const eliminated = await this.eliminatePlayer('),
      ELIM.indexOf('takenPositions.add(place);')
    );
    expect(loop).toMatch(/this\.bustRefusalStreak\.set\(/);
    expect(loop, 'the abort itself is deliberate and stays').toMatch(/return;/);
  });

  it('clears the streak the moment a player is actually eliminated', () => {
    expect(ELIM).toMatch(/this\.bustRefusalStreak\.delete\(bustedOrdered\[i\]\.user_id\)/);
  });

  it('orders by hand and starting stack before its exact-tie refusal streak', () => {
    // The chip tiebreak became the LAST resort on 2026-09-09: every candidate
    // here holds zero, so chips decided nothing, and the resulting arbitrary
    // order stranded 49 PKO bounties behind the settlement watermark. The
    // Hand number is the primary witness, then the accepted hand's starting
    // stack resolves simultaneous busts. Refusal rotation is only a final
    // exact-tie mechanism and cannot advance the PKO watermark.
    const order = ELIM.slice(
      ELIM.indexOf('const compareBusted ='),
      ELIM.indexOf('const bustedTotal = busted.length')
    );
    expect(order).toMatch(/bustRank\(a\.user_id\) - bustRank\(b\.user_id\)/);
    expect(order).toMatch(/bustStartingStack\(a\.user_id\) - bustStartingStack\(b\.user_id\)/);
    expect(order).toMatch(/this\.bustRefusalStreak\.get\(a\.user_id\) \?\? 0/);
    expect(order.indexOf('bustRank(a.user_id)')).toBeLessThan(
      order.indexOf('bustStartingStack(a.user_id)')
    );
    expect(order.indexOf('bustStartingStack(a.user_id)')).toBeLessThan(
      order.indexOf('bustRefusalStreak')
    );
    expect(order).toContain('a.user_id.localeCompare(b.user_id)');
    expect(ELIM).toContain('let bustedOrdered = [...busted].sort(compareBusted)');
  });

  it('reads the complete bust order before slicing and fails closed on a partial read', () => {
    expect(ELIM).toMatch(
      /\.from\('tournament_knockout_candidates'\)\s*\.select\('eliminated_user_id, hand_number, stack_before'\)/
    );
    const orderReadAt = ELIM.indexOf('const bustHandNumbers = new Map<string, number>()');
    const sliceAt = ELIM.indexOf('const bustedTotal = busted.length');
    expect(orderReadAt).toBeGreaterThan(0);
    expect(orderReadAt).toBeLessThan(sliceAt);
    const readFailure = ELIM.slice(
      ELIM.indexOf('if (bustHandsErr)'),
      ELIM.indexOf('const bustRank =')
    );
    expect(readFailure).toMatch(/'Tournament\.bust_order_unreadable'/);
    expect(readFailure).toContain('requestUrgentEliminationSweepAfter');
    expect(readFailure).toMatch(/\breturn;/);
    // A genuinely missing row is still UNKNOWN and must not sort to the front.
    expect(ELIM).toMatch(/bustHandNumbers\.get\(userId\) \?\? Number\.MAX_SAFE_INTEGER/);
  });
});

describe('the launch proof tells a bust from an uncredited stack', () => {
  /**
   * `chips > 0` on every roster row cannot distinguish "the stacks were never
   * credited" from "they were credited and then played for". Eight Spins sat in
   * REGISTERING because of it, one for ten hours, retrying every thirty seconds
   * - 478 refusals in half an hour. Each roster summed to EXACTLY
   * 3 x starting_chips with one seat at zero, because the table had already
   * dealt (one of them 73 hands) before the launch was proven.
   */
  it('no longer refuses a roster row merely for holding zero', () => {
    expect(BASE).not.toMatch(
      /the playing roster does not have positive chips and an exact table seat/
    );
    expect(BASE).toMatch(/the playing roster does not have a finite stack and an exact table seat/);
  });

  it('refuses a NEGATIVE or non-finite stack, which is impossible rather than busted', () => {
    const guard = BASE.slice(
      BASE.indexOf('the playing roster does not have a finite stack') - 700,
      BASE.indexOf('the playing roster does not have a finite stack')
    );
    expect(guard).toMatch(/Number\(row\.chips\) < 0/);
    expect(guard).not.toMatch(/Number\(row\.chips\) <= 0/);
  });

  it('asserts conservation instead: the roster must hold what its seats were bought for', () => {
    expect(BASE).toMatch(/const expectedFloor = fundingFieldSize \* startingChips;/);
    expect(BASE).toMatch(
      /launchStacksMeetFundingFloor\(\s*roster\.map\(\(row\) => row\.chips\),\s*startingChips/
    );
    // The original hazard - a field with no money on it - is still refused.
    expect(BASE).toMatch(/the playing roster holds no chips at all/);
  });

  it('applies the same rule to the felt, and still requires a funded total there', () => {
    expect(BASE).toMatch(/Number\(seat\.stack\) < 0/);
    expect(BASE).toMatch(/const seatChips = seats\.reduce\(/);
    expect(BASE).toMatch(
      /launchStacksMeetFundingFloor\(\s*seats\.map\(\(seat\) => seat\.stack\),\s*startingChips/
    );
    expect(BASE).toMatch(/the felt holds \$\{seatChips\} chips, short of the/);
  });

  it('allows redistribution only behind the exact played-Spin proof', () => {
    expect(BASE).toContain('playedSpinRecovery === null');
    expect(BASE).toContain('an ordinary seat-first roster does not hold its exact starting stacks');
    expect(BASE).toContain('does not hold the exact seat-first starting stack');
    expect(BASE).toMatch(/Number\(seat\.stack\) !== startingChips/);
    expect(BASE).toMatch(/Number\(row\.chips\) !== startingChips/);
    expect(BASE).toContain('Number(seat.stack) !== Number(player.chips)');
  });

  it('has no deferred-stack window: atomic launch credit is proven before both conservation checks', () => {
    expect(BASE).not.toMatch(/deferStacksForSpinReveal|stacksMayBeDeferred|seats_credited/);
    expect(BASE).toMatch(
      /const rosterChips = roster\.reduce\([\s\S]*?const expectedFloor = fundingFieldSize \* startingChips;[\s\S]*?launchStacksMeetFundingFloor\(\s*roster\.map\(\(row\) => row\.chips\),\s*startingChips,\s*fundingFieldSize/
    );
    expect(BASE).toMatch(
      /const seatChips = seats\.reduce\([\s\S]*?launchStacksMeetFundingFloor\(\s*seats\.map\(\(seat\) => seat\.stack\),\s*startingChips,\s*fundingFieldSize/
    );
  });
});

describe('the migration that ships beside this one', () => {
  const MIGRATION = readFileSync(
    resolve(
      __dirname,
      '../../../supabase/migrations/20260909215641_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
    ),
    'utf8'
  );

  it('never invents a rebuy while eliminating a later generation', () => {
    const elimination = MIGRATION.slice(
      MIGRATION.lastIndexOf(
        'CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic('
      ),
      MIGRATION.indexOf(
        '$function$;',
        MIGRATION.lastIndexOf(
          'CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic('
        )
      )
    );
    expect(elimination).not.toMatch(/SET state='rebought'/);
    expect(elimination).not.toMatch(/max\([^)]*joined_at/);
    expect(elimination).toMatch(/AND c\.state<>'rebought'/);
    expect(elimination).toMatch(/'unresolved_knockout_generation_chain'/);
  });

  it('selects the immutable latest candidate and proves its exact accepted hand', () => {
    expect(MIGRATION).toMatch(/fn_ca_latest_committed_knockout_candidate\(/);
    expect(MIGRATION).toMatch(/a\.table_id=v_candidate\.table_id/);
    expect(MIGRATION).toMatch(/a\.hand_number=v_candidate\.hand_number/);
    expect(MIGRATION).toMatch(/a\.hand_id=v_candidate\.hand_id/);
    expect(MIGRATION).toMatch(/v_settlement_hand_id:=v_settlement_hand_text::uuid/);
    expect(MIGRATION).toMatch(/k\.hand_id=v_settlement_hand_id/);
    expect(MIGRATION).toMatch(/'knockout_candidate_required'/);
    expect(MIGRATION).not.toMatch(/ORDER BY \(k\.result->>'hand_number'\)::bigint DESC/);
    expect(MIGRATION).not.toMatch(/SELECT max\(c2\.seat_joined_at\)/);
  });

  it('keeps the function closed to every browser role', () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_eliminate_tournament_player_atomic/
    );
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role;/);
    expect(MIGRATION).not.toMatch(/TO (authenticated|anon)\b/);
  });

  it('is one transaction, per the production DDL policy', () => {
    expect(MIGRATION.match(/^BEGIN;/gm) ?? []).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;/gm) ?? []).toHaveLength(1);
  });
});
