/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TRANSIENT REFUSAL IS NEWS WHEN IT STOPS BEING TRANSIENT (2026-10-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TRANSIENT_FINISH_REFUSALS` (deadlock, timeout) are, by the engine's own
 * definition, the database saying "not now": the next pass clears them. A
 * critical money alert on the FIRST one measures finish-lane contention, not
 * an unpaid finish. Measured on production 2026-09-26 .. 2026-10-01:
 *
 *   Tournament.atomic_finish_refused, unresolved         347
 *     of which the tournament is COMPLETED with a receipt 342 (333 timeout,
 *                                                             7 deadlock, 2 other)
 *     of which RUNNING, refused in the last ten minutes      6
 *   ca_drift_incidents open for this source                  23 (22 + storm row)
 *   money named as owed by any of them                        0
 *
 * Each of the 342 was refused exactly once - 55P03 on the single platform
 * finish lane, 8 s lock_timeout, five attempts and the resolver - and paid in
 * full on a later admission. The refusal is still counted on
 * poker_tournament_finish_refusals_total{reason}; what changes is when an
 * operator is told: a transient reason reported by the same tournament
 * TRANSIENT_FINISH_REFUSAL_ALERT_STREAK times running, which is a wedged lane,
 * not a busy one. A rule refusal is still news on its first report.
 *
 * The second half of this law is WHY the retry took 17-44 minutes: a refused
 * finish spends its admission's budget, so completedStage(3) advanced the
 * cursor past the finish stage and the re-armed admission ran stages 3..8
 * before the finish was asked again - two trips through a scheduler queue
 * whose oldest wait was 589-1,121 s. The retry now rewinds to the finish
 * stage, so the winner is owed the next admission.
 *
 * The third half is the same shape one layer down: a lock timeout (55P03)
 * aborts a statement before it commits anything, exactly as a deadlock does,
 * and isTransientDbError listed the deadlock and not its twin.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { FINISH_STAGE, TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';
import { ServerTableEngineBase } from '../engine/ServerTableEngineBase.js';
import { TRANSIENT_FINISH_REFUSALS } from '../observability/engineInstruments.js';

const MANAGER = readFileSync(resolve(__dirname, './TournamentManagerBase.ts'), 'utf8');
const ELIM = readFileSync(resolve(__dirname, './TournamentManagerEliminations.ts'), 'utf8');
const SETTLEMENT = readFileSync(
  resolve(__dirname, '../engine/ServerTableEngineSettlement.ts'),
  'utf8'
);

/** A bare manager: the two private fields noteFinishRefusal reads, nothing else. */
function bareManager(): {
  note: (proven: boolean, err: unknown) => boolean;
  clear: () => void;
  streak: () => number;
} {
  const m = Object.create(TournamentManagerBase.prototype) as any;
  m.finishRefusalStreak = 0;
  m.lastFinishRefusalReason = null;
  return {
    note: (proven, err) => m.noteFinishRefusal(proven, err),
    clear: () => m.clearFinishRefusalStreak(),
    streak: () => m.currentFinishRefusalStreak,
  };
}

const THRESHOLD = TournamentManagerBase.TRANSIENT_FINISH_REFUSAL_ALERT_STREAK;

describe('when a refused finish is news', () => {
  it('the threshold is more than one and small enough to notice a wedged lane in a minute', () => {
    // Five attempts and the resolver cost ~48 s per refused pass against an
    // 8 s lock_timeout, so three passes is about two and a half minutes of a
    // lane that has not served this tournament once.
    expect(THRESHOLD).toBeGreaterThan(1);
    expect(THRESHOLD).toBeLessThanOrEqual(5);
  });

  it.each([...TRANSIENT_FINISH_REFUSALS])(
    'a %s refusal is news exactly once, on the pass the streak reaches the threshold',
    (reason) => {
      const m = bareManager();
      const err = new Error(
        reason === 'deadlock' ? 'deadlock detected' : 'canceling statement due to lock timeout'
      );
      const verdicts: boolean[] = [];
      for (let pass = 1; pass <= THRESHOLD + 2; pass++) verdicts.push(m.note(true, err));
      expect(verdicts.filter(Boolean)).toHaveLength(1);
      expect(verdicts.indexOf(true) + 1).toBe(THRESHOLD);
      expect(m.streak()).toBe(THRESHOLD + 2);
    }
  );

  it('a rule refusal is still news on its first report, and only then', () => {
    const m = bareManager();
    const err = new Error('tournament_fee_sources_require_reconciliation');
    expect(m.note(true, err)).toBe(true);
    expect(m.note(true, err)).toBe(false);
    expect(m.note(true, err)).toBe(false);
  });

  it('a different reason restarts the streak, so a lane timeout after a rule refusal is not hidden behind it', () => {
    const m = bareManager();
    expect(m.note(true, new Error('tournament_fee_sources_require_reconciliation'))).toBe(true);
    const timeout = new Error('canceling statement due to lock timeout');
    expect(m.note(true, timeout)).toBe(false);
    expect(m.streak()).toBe(1);
    for (let pass = 2; pass < THRESHOLD; pass++) expect(m.note(true, timeout)).toBe(false);
    expect(m.note(true, timeout)).toBe(true);
  });

  it('a committed settlement clears the streak, so the next transient refusal starts counting again', () => {
    const m = bareManager();
    const timeout = new Error('canceling statement due to lock timeout');
    for (let pass = 1; pass < THRESHOLD; pass++) m.note(true, timeout);
    m.clear();
    expect(m.streak()).toBe(0);
    expect(m.note(true, timeout)).toBe(false);
    expect(m.streak()).toBe(1);
  });

  it('an unproven outcome is always news', () => {
    const m = bareManager();
    expect(m.note(false, new Error('lost response'))).toBe(true);
    expect(m.note(false, new Error('lost response'))).toBe(true);
  });

  it('the alert that is raised says how many times running the lane refused', () => {
    const helper = sliceMethod(MANAGER, 'protected async alertFinishRefusalOnce(');
    expect(helper).toContain('refusal_streak: this.finishRefusalStreak');
  });
});

describe('the retry goes straight back to the finish', () => {
  it('rearmIfTheFinishWasRefused rewinds the sweep cursor to the finish stage', () => {
    const m = Object.create(TournamentManagerEliminations.prototype) as any;
    m.tournamentFinished = false;
    m.eliminationSweepCursor = new TournamentSweepWorkCursor();
    m.requestUrgentEliminationSweepAfter = vi.fn();
    // The refused finish's admission has advanced past the finish stage.
    m.eliminationSweepCursor.advanceTo(FINISH_STAGE + 1);
    m.rearmIfTheFinishWasRefused();
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(
      TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
    );
    // Applied at the next admission, as every rewind is.
    m.eliminationSweepCursor.beginAdmission();
    expect(m.eliminationSweepNextStage).toBe(FINISH_STAGE);
  });

  it('a finish that committed does not rewind anything', () => {
    const m = Object.create(TournamentManagerEliminations.prototype) as any;
    m.tournamentFinished = true;
    m.eliminationSweepCursor = new TournamentSweepWorkCursor();
    m.requestUrgentEliminationSweepAfter = vi.fn();
    m.eliminationSweepCursor.advanceTo(FINISH_STAGE + 1);
    m.rearmIfTheFinishWasRefused();
    expect(m.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
    m.eliminationSweepCursor.beginAdmission();
    expect(m.eliminationSweepNextStage).toBe(FINISH_STAGE + 1);
  });

  it('the finish stage the cursor rewinds to is the one that gates finishStage', () => {
    expect(ELIM).toContain(
      'if (this.eliminationSweepCursor.nextStage > FINISH_STAGE) break finishStage;'
    );
    expect(FINISH_STAGE).toBe(2);
  });
});

describe('a lock timeout is a rollback, not a decision', () => {
  const transient = (err: unknown) => (ServerTableEngineBase as any).isTransientDbError(err);

  it('55P03 by code and by message is transient, like the deadlock beside it', () => {
    expect(transient(new Error('canceling statement due to lock timeout'))).toBe(true);
    expect(transient({ code: '55P03', message: 'lock not available' })).toBe(true);
    expect(transient(new Error('deadlock detected'))).toBe(true);
  });

  it('a refusal the database meant is still not transient', () => {
    expect(transient(new Error('Pending Departure Read Failed'))).toBe(false);
    expect(transient(new Error('tournament_fee_sources_require_reconciliation'))).toBe(false);
    expect(transient({ code: '23505', message: 'duplicate key' })).toBe(false);
  });
});

describe('a step that cannot lose a chip does not page as if it had', () => {
  it('leave_pending reports its failure as a warning that asserts moves_chips: false', () => {
    expect(SETTLEMENT).toMatch(/STEP_FAILURE_SEVERITY[^}]*leave_pending: 'warning'/s);
    expect(SETTLEMENT).toMatch(/STEP_FAILURE_MOVES_CHIPS[^}]*leave_pending: false/s);
    expect(SETTLEMENT).toContain("STEP_FAILURE_SEVERITY[stepName] ?? 'critical'");
    expect(SETTLEMENT).toContain('moves_chips: movesChips');
  });

  it('every other money-critical step still pages critical by default', () => {
    // The map names exactly the steps whose failure paths were read and
    // proven chip-free. Adding one here is a decision, not a convenience.
    const severity = SETTLEMENT.slice(
      SETTLEMENT.indexOf('const STEP_FAILURE_SEVERITY'),
      SETTLEMENT.indexOf('};', SETTLEMENT.indexOf('const STEP_FAILURE_SEVERITY'))
    );
    expect(severity.match(/^\s+\w+: '/gm) ?? []).toHaveLength(1);
  });
});
