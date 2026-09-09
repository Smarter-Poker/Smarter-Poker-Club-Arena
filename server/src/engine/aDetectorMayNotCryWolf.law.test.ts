/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DETECTOR MAY NOT CRY WOLF (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Drift Incidents board showed 500 open criticals; the table held 3,402.
 * 3,330 of them - 98% - were THREE conditions re-filed once per hand. The real
 * findings underneath (a club treasury reconciliation, a diamond-supply
 * breach) were invisible.
 *
 * Section 10.8 says a check nobody can see is not a check. This is the same
 * law from the other end: a check that fires 1,058 times for a condition that
 * always clears is not a strict check, it is a broken one, because it trains
 * everyone to stop reading the board.
 *
 * Three defects, each pinned below. The amplification itself is fixed in the
 * database (migration `one_cause_is_one_incident_not_one_per_hand`, plus the
 * storm cap in `no_detector_may_flood_the_board`).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeError } from '../services/errorReporter.js';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const SETTLEMENT = read('./ServerTableEngineSettlement.ts');
const PROJECTION = read('../services/supabase/handProjection.ts');
const MOVES = read('../tournament/TournamentManager.ts');

/** The body of `catch (err) {` inside the post-commit obligations retry loop. */
function obligationsRetryCatch(): string {
  const start = SETTLEMENT.indexOf('const outcome = await processHandPostCommitObligations');
  expect(start, 'the post-commit obligations retry loop has moved').toBeGreaterThan(-1);
  const end = SETTLEMENT.indexOf('postCommitStateCanReflect = this.lifecycleCanMutate();', start);
  expect(end, 'the end of the obligations loop has moved').toBeGreaterThan(start);
  return SETTLEMENT.slice(start, end);
}

describe('the obligations alarm belongs to the give-up, not to attempt 1', () => {
  /**
   * 1,058 hands filed this CRITICAL alert on 2026-09-08/09. All 1,058 had
   * `post_commit_completed_at` set: 0 pending, 0 chips stranded. It was raised
   * on the first failure of a bounded retry that then succeeded every time.
   */
  it('does not raise a financial alert inside the retry loop', () => {
    const loop = obligationsRetryCatch();
    expect(loop).not.toMatch(/attempt === 1\s*\)\s*\{[\s\S]*?raiseFinancialAlert/);
    expect(loop).not.toContain('raiseFinancialAlert');
  });

  it('still reports every attempt to Sentry, so the transient stays visible', () => {
    expect(obligationsRetryCatch()).toMatch(
      /reportError\(\s*err,\s*'ServerTableEngine\.post_commit_obligations_pending'/
    );
  });

  it('raises the alert where the loop actually abandons the envelope', () => {
    const giveUp = SETTLEMENT.slice(SETTLEMENT.indexOf('if (!obligationsApplied) {'));
    expect(giveUp).toContain("'ServerTableEngine.post_commit_obligations_pending'");
    expect(giveUp).toContain('raiseFinancialAlert');
    // and it must say how many attempts it made before giving up
    expect(giveUp).toMatch(/attempts:\s*attempt/);
  });
});

describe('an error report never says "[object Object]"', () => {
  /**
   * Supabase rejects with a PostgrestError - a plain object, never an Error -
   * so `String(err)` printed those four words and destroyed the diagnosis on
   * every one of the 1,058 alerts. The dashboard classified them all
   * `unknown` because there was nothing left to classify.
   */
  it('reads a PostgrestError-shaped rejection', () => {
    const pgrst = { message: 'permission denied for table hand_atomic_commits', code: '42501' };
    expect(describeError(pgrst)).toBe('permission denied for table hand_atomic_commits (42501)');
    expect(describeError(pgrst)).not.toContain('[object Object]');
  });

  it('never returns the literal "[object Object]" for any object', () => {
    for (const v of [{}, { details: 'd' }, { hint: 'h' }, { error_description: 'e' }, { a: 1 }]) {
      expect(describeError(v)).not.toContain('[object Object]');
    }
  });

  it('still passes an Error and a string straight through', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('boom')).toBe('boom');
  });

  it('the money paths use it instead of String(err)', () => {
    expect(SETTLEMENT).not.toMatch(/error:\s*err instanceof Error \? err\.message : String\(err\)/);
    expect(SETTLEMENT).toContain('describeError(lastObligationError)');
    // the projection layer must not rethrow the bare PostgrestError either
    expect(PROJECTION).not.toMatch(/if \(error\) throw error;/);
    expect(PROJECTION).not.toMatch(/throw targetError;/);
    expect(PROJECTION).not.toMatch(/throw earlierError;/);
    expect(PROJECTION).toContain('describeError');
  });
});

describe('a dealt hand is not thrown away by the table balancer', () => {
  /**
   * `executePlayerMoves` vacated a source seat with no hand-in-flight check of
   * its own. Its two callers probe `waitForHandComplete` ONCE PER BATCH, and
   * the loop then spends several awaited round trips per move, so the boundary
   * checked before move 1 is stale by move N. Measured 2026-09-08/09: 32 fully
   * dealt tournament hands discarded, leave/join pairs 0.17-0.37s apart.
   * `fn_ca_settle_hand_stacks_absolute` then raises `seat missing or left ...
   * hand write rejected whole`, which aborts the whole commit and kills the
   * engine generation - every player at the table loses the hand.
   */
  /**
   * THE DESTRUCTIVE CALL MOVED, THE LAW DID NOT (2026-09-09). The seat is no
   * longer vacated by an UPDATE in this method - the whole move is one
   * database transaction, `fn_ca_move_tournament_seat`. Atomicity protects the
   * MOVER, so a refused move now leaves them exactly where they were. It says
   * nothing about the hand the other eight players are in the middle of, which
   * lives in the engine and not in the database, so this probe is still the
   * only thing standing between a rebalance and 32 discarded hands.
   */
  function vacateSite(): { guard: string } {
    const vacate = MOVES.indexOf("supabase.rpc('fn_ca_move_tournament_seat'");
    expect(vacate, 'the move call has moved').toBeGreaterThan(-1);
    // look back over the immediately preceding block only
    return { guard: MOVES.slice(Math.max(0, vacate - 2600), vacate) };
  }

  it('re-probes the hand boundary immediately before moving the seat', () => {
    expect(vacateSite().guard).toMatch(
      /if \(!\(await this\.waitForHandComplete\(move\.fromTableId\)\)\) \{/
    );
  });

  it('leaves the player where they are and retries, rather than moving them', () => {
    const g = vacateSite().guard;
    expect(g).toMatch(
      /requestUrgentEliminationSweepAfter\(TournamentManagerBase\.BALANCE_REDRIVE_MS\)/
    );
    expect(g).toMatch(/continue;/);
  });

  it('checks before anything is written, so a refusal writes nothing', () => {
    // The guard must sit BEFORE the move call. If it ever lands after it, a
    // hand in flight would already have been thrown away by the time we look.
    const guardAt = MOVES.indexOf('if (!(await this.waitForHandComplete(move.fromTableId)))');
    const moveAt = MOVES.indexOf("supabase.rpc('fn_ca_move_tournament_seat'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(moveAt);
  });
});
