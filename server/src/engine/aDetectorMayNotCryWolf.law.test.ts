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
const ENGINE = read('./ServerTableEngineBase.ts');
const GAME_SERVER = read('../GameServer.ts');
const MANAGER_BASE = read('../tournament/TournamentManagerBase.ts');

/** The body of `catch (err) {` inside the post-commit obligations retry loop. */
function obligationsRetryCatch(): string {
  // Include the complete retry loop regardless of the observation wrapper
  // around its awaited processor. The financial-alert prohibition is intact.
  const start = SETTLEMENT.indexOf('while (!obligationsApplied && mayStillDrain())');
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
  it('requires one identical tournament engine generation in both registries', () => {
    const claim = MOVES.slice(
      MOVES.indexOf('private async claimTournamentMoveBoundary'),
      MOVES.indexOf('private requestTournamentSeatMoveAtBoundary')
    );
    expect(claim).toContain('serverEngine !== managerEngine');
    expect(claim).toContain('this.gameServer.ownsTournamentTableEngine');
    expect(claim).toContain('await managerEngine.parkForTournamentMove(');
    expect(GAME_SERVER).toContain('this.tournamentOwnedTables.has(tableId)');
  });

  it('moves only inside the claimed physical engine boundary', () => {
    const request = MOVES.slice(
      MOVES.indexOf('private requestTournamentSeatMoveAtBoundary'),
      MOVES.indexOf('protected redrivePendingTournamentSeatMoveOutcomes')
    );
    expect(request).toContain('executeTournamentMoveAtBoundary(');
    expect(request).toMatch(
      /\(\) =>\s*moveTournamentPlayerAtomically\(input, \{ outcomeWasAlreadyUnknown \}\)/
    );
    expect(ENGINE).toContain('this.handForHandResolve !== null');
    expect(ENGINE).toContain('this.postHandTasksPromise === null');
    expect(ENGINE).toContain('this.tournamentMoveOperations.add(barrier)');
  });

  it('retains an unknown move UUID and source fence until exact replay resolves', () => {
    const execute = MOVES.slice(
      MOVES.indexOf('private async executePlayerMovesOwned'),
      MOVES.indexOf('protected async waitForHandComplete')
    );
    const unknown = execute.indexOf('moveErr instanceof TournamentSeatMoveOutcomeUnknownError');
    const retain = execute.indexOf('this.pendingTournamentSeatMoveOutcomes.set(requestId', unknown);
    const release = execute.indexOf('releaseTournamentMovePause', retain);
    expect(unknown).toBeGreaterThan(-1);
    expect(retain).toBeGreaterThan(unknown);
    expect(release).toBeGreaterThan(retain);
    expect(execute.slice(retain, release)).toContain('retainedUnknownSources.has(sourceTableId)');

    const replay = MOVES.slice(
      MOVES.indexOf('private async redrivePendingTournamentSeatMoveOutcomesOwned'),
      MOVES.indexOf('protected resolveTournamentSeatMoveQuarantine')
    );
    expect(replay).toContain('pending.input');
    expect(replay).not.toContain('randomUUID()');
    expect(replay).toMatch(/pending\.input,[\s\S]{0,80}boundary,[\s\S]{0,40}true/);
    const caught = replay.indexOf('} catch (moveErr)');
    expect(replay.indexOf('pendingTournamentSeatMoveOutcomes.delete(requestId)', caught)).toBe(-1);
    expect(replay).toContain('Tournament.atomic_move_replay_boundary_unavailable');
  });

  it('does not replace the fenced engine generation while a move outcome is unknown', () => {
    const replace = GAME_SERVER.slice(
      GAME_SERVER.indexOf('async replaceTableEngine('),
      GAME_SERVER.indexOf(
        'unregisterTournamentTableEngine(',
        GAME_SERVER.indexOf('async replaceTableEngine(')
      )
    );
    expect(replace).toContain('expected.hasClaimedTournamentMoveBoundary()');
    expect(replace.indexOf('expected.hasClaimedTournamentMoveBoundary()')).toBeLessThan(
      replace.indexOf('replaceOwnedTableEngine(')
    );
    const recovery = MANAGER_BASE.slice(
      MANAGER_BASE.indexOf('private async performManagedTableEngineRecovery'),
      MANAGER_BASE.indexOf(
        'protected startManagedTableEngine',
        MANAGER_BASE.indexOf('private async performManagedTableEngineRecovery')
      )
    );
    expect(recovery).toContain('await this.resolveTournamentSeatMoveQuarantine(tableId, engine)');
    expect(recovery).toContain('this.gameServer.ownsTournamentTableEngine(tableId, engine)');
    expect(recovery).toContain("this.requestEliminationSweep('seat_move_outcome_pending')");
  });

  /**
   * 2026-09-12: this pin used to read "only through the closed-orphan database
   * mode", and that rule was itself the defect. A table holding one player
   * cannot deal, so it holds no engine generation, so the live-source fence
   * refused its move for ever while the database accepted the identical move -
   * a stable deadlock across 65 events. The mode never proved anything the two
   * registries did not. The pin moves to the property that actually keeps the
   * boundary honest: the engineless path is taken ONLY when both registries
   * are empty, and that is proven again immediately before the RPC.
   */
  it('allows no-engine movement in any mode, but only with no engine generation', () => {
    expect(MOVES).toContain("move.reason === CLOSED_ORPHAN_RESEAT_REASON ? 'closed_orphan'");
    const claim = MOVES.slice(
      MOVES.indexOf('private async claimTournamentMoveBoundary'),
      MOVES.indexOf('private requestTournamentSeatMoveAtBoundary')
    );
    expect(claim).toContain('if (!managerEngine && !serverEngine) {');
    const request = MOVES.slice(
      MOVES.indexOf('private requestTournamentSeatMoveAtBoundary'),
      MOVES.indexOf('protected redrivePendingTournamentSeatMoveOutcomes')
    );
    expect(request).toContain('this.tableEngines.has(input.sourceTableId)');
    expect(request).toContain('this.gameServer.getTableEngine(input.sourceTableId)');
    expect(request).toContain('engineless source boundary is no longer exact');
    expect(request, 'the mode may no longer decide the engineless path').not.toContain(
      "input.sourceMode !== 'closed_orphan'"
    );
    expect(MOVES).not.toMatch(
      /\.from\(['"]table_seats['"]\)[\s\S]{0,120}\.(?:update|insert|delete)\(/
    );
  });
});
