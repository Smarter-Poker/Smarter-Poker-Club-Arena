/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A RULE REFUSAL STOPS ASKING EVERY FIVE SECONDS (2026-09-18)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-09 established that a refused finish must ask for another pass, and
 * `aRefusedFinishAsksForAnotherPass` pins the listener it added. The delay it
 * asks with is UNRESOLVED_BUST_RETRY_MS: five seconds.
 *
 * Five seconds is right for a deadlock victim or a statement timeout. It is
 * the wrong question to re-ask for a refusal that is a rule. Measured on
 * production at 03:46 UTC on 2026-09-18:
 *
 *   elimination_scheduler_queue_depth        652
 *   elimination_scheduler_slots_inflight       5   (cap 4, one stalled)
 *   elimination_scheduler_oldest_wait_ms  469125   (7.8 minutes)
 *   tournaments_decided_unfinished           547
 *   finish_refusals_total{fee_reconciliation} 1462 in thirty minutes
 *
 * 547 decided tournaments were asking, every five seconds, a question the
 * database had already answered 1,462 times with the same rule refusal:
 * tournament_fee_sources_require_reconciliation, raised because the entry fee
 * was charged before the accounting cutover and can never be batched. They
 * occupied the elimination scheduler, and a healthy tournament's elimination
 * waited nearly eight minutes behind them. Every pass also raised its own
 * critical money alert; 3,076 sat open and unread.
 *
 * These pins are the refinement, not a repeal. The refusal is still eligible
 * for a corrected retry. It waits longer each time for a reason that cannot
 * change on its own, and it says the same thing to an operator once.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import {
  FINISH_REFUSAL_BACKOFF_CAP_MS,
  FINISH_REFUSAL_REASONS,
  TRANSIENT_FINISH_REFUSALS,
  classifyFinishRefusal,
  finishRefusalIsTransient,
  finishRefusalRetryDelayMs,
} from '../observability/engineInstruments.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';

const ELIM = readFileSync(resolve(__dirname, './TournamentManagerEliminations.ts'), 'utf8');
// The bookkeeping lives beside the constant its delay is derived from, and
// beside requestUrgentEliminationSweepAfter. The call sites are in Eliminations.
const MANAGER = readFileSync(resolve(__dirname, './TournamentManagerBase.ts'), 'utf8');
const BASE = TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS;

describe('which refusals a retry can clear', () => {
  it('a deadlock and a timeout are the only transients', () => {
    expect([...TRANSIENT_FINISH_REFUSALS].sort()).toEqual(['deadlock', 'timeout']);
    for (const reason of FINISH_REFUSAL_REASONS) {
      expect(finishRefusalIsTransient(reason)).toBe(reason === 'deadlock' || reason === 'timeout');
    }
  });

  it('the refusal that froze 547 tournaments is not a transient', () => {
    // The exact message the database raises, through the classifier that reads
    // it. If this ever classifies as transient, the treadmill is back.
    const reason = classifyFinishRefusal(
      'tournament 0e1d5b0a rake attribution incomplete: tournament_fee_sources_require_reconciliation'
    );
    expect(reason).toBe('fee_reconciliation');
    expect(finishRefusalIsTransient(reason)).toBe(false);
  });
});

describe('the delay a refused finish waits', () => {
  it('a transient refusal keeps the five-second pass, however many times it happens', () => {
    for (const streak of [1, 2, 5, 40]) {
      expect(finishRefusalRetryDelayMs('deadlock', streak, BASE)).toBe(BASE);
      expect(finishRefusalRetryDelayMs('timeout', streak, BASE)).toBe(BASE);
    }
  });

  it('the first refusal of any kind still retries at the base delay', () => {
    // A rule refusal gets one fast pass: the correction may have landed in the
    // five seconds since the sweep read the field.
    for (const reason of FINISH_REFUSAL_REASONS) {
      expect(finishRefusalRetryDelayMs(reason, 1, BASE)).toBe(BASE);
    }
  });

  it('a repeated rule refusal doubles away from the base', () => {
    expect(finishRefusalRetryDelayMs('fee_reconciliation', 2, BASE)).toBe(BASE * 2);
    expect(finishRefusalRetryDelayMs('fee_reconciliation', 3, BASE)).toBe(BASE * 4);
    expect(finishRefusalRetryDelayMs('prize_set', 4, BASE)).toBe(BASE * 8);
  });

  it('and stops at fifteen minutes, which is inside the hour between breaks', () => {
    expect(FINISH_REFUSAL_BACKOFF_CAP_MS).toBe(15 * 60 * 1000);
    expect(FINISH_REFUSAL_BACKOFF_CAP_MS).toBeLessThan(60 * 60 * 1000);
    for (const streak of [9, 12, 20, 500]) {
      expect(finishRefusalRetryDelayMs('fee_reconciliation', streak, BASE)).toBe(
        FINISH_REFUSAL_BACKOFF_CAP_MS
      );
    }
  });

  it('never returns a negative or non-finite delay', () => {
    for (const base of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const delay = finishRefusalRetryDelayMs('fee_reconciliation', 3, base);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
    expect(finishRefusalRetryDelayMs('fee_reconciliation', 0, BASE)).toBe(BASE);
    expect(finishRefusalRetryDelayMs('fee_reconciliation', -7, BASE)).toBe(BASE);
  });

  it('the cap is reached inside one release cycle, not eventually', () => {
    // 5s doubling to the cap is nine refusals and 2,175 seconds of waiting -
    // thirty-six minutes - before a tournament settles onto the cap and stops
    // churning. That has to be inside the hour between maintenance breaks, or
    // a refusing tournament would still be escalating when the next release
    // window opens.
    let elapsed = 0;
    let onTheCap = 0;
    for (let streak = 1; streak <= 9; streak++) {
      const delay = finishRefusalRetryDelayMs('fee_reconciliation', streak, BASE);
      elapsed += delay;
      if (delay === FINISH_REFUSAL_BACKOFF_CAP_MS) onTheCap = streak;
    }
    expect(elapsed).toBe(2_175_000);
    expect(elapsed).toBeLessThan(60 * 60 * 1000);
    expect(onTheCap).toBe(9);
  });
});

describe('the manager asks with that delay and alerts once', () => {
  const FINISH = sliceMethod(ELIM, 'finishTournament(winnerId: string): Promise<void>');

  it('the window under test is real', () => {
    expect(FINISH.length).toBeGreaterThan(2000);
  });

  it('the guard still hands the finish back through the sweep scheduler', () => {
    // The 2026-09-09 law: not a bare timer, and the flag is given back.
    expect(FINISH).toMatch(
      /const releaseFinishGuard = \(\): void => \{[\s\S]*?this\.tournamentFinished = false;[\s\S]*?this\.requestUrgentEliminationSweepAfter\(/
    );
    const guard = FINISH.slice(
      FINISH.indexOf('const releaseFinishGuard'),
      FINISH.indexOf('const releaseFinishGuard') + 600
    );
    expect(guard).not.toMatch(/setTimeout\(|setInterval\(/);
  });

  it('but with the classified delay, not the flat constant', () => {
    const guard = FINISH.slice(
      FINISH.indexOf('const releaseFinishGuard'),
      FINISH.indexOf('const releaseFinishGuard') + 600
    );
    expect(guard).toContain('this.requestUrgentEliminationSweepAfter(this.finishRetryDelayMs())');
  });

  it('every proven refusal is recorded before its alert is decided', () => {
    // Order matters: noteFinishRefusal both counts the streak and answers
    // whether an operator has already been told. Alerting first would send
    // every repeat.
    for (const anchor of ['satErr', 'settlementErr']) {
      const noted = ELIM.indexOf(
        `const alertIsNew = this.noteFinishRefusal(provenRefusal, ${anchor})`
      );
      expect(noted, `${anchor} refusal is noted`).toBeGreaterThan(0);
    }
    expect(ELIM).toContain('await this.alertFinishRefusalOnce(');
  });

  it('no refusal boundary calls raiseFinancialAlert directly any more', () => {
    // Both money-refusal boundaries go through the once-per-reason helper. The
    // helper itself is the only caller left inside it.
    const direct = FINISH.match(/await raiseFinancialAlert\(/g) ?? [];
    expect(direct).toHaveLength(0);
  });

  it('a committed settlement clears the streak, so the next refusal is news', () => {
    expect(ELIM).toMatch(
      /this\.committedFinishReceipt = receipt;\s*\n\s*this\.clearFinishRefusalStreak\(\);/
    );
    expect(ELIM).toMatch(
      /this\.committedSatelliteReceipt = receipt;\s*\n\s*this\.clearFinishRefusalStreak\(\);/
    );
  });

  it('the suppressed repeats are counted, never silent', () => {
    expect(MANAGER).toContain('tournamentFinishRefusalAlertsSuppressedTotal.inc(1, { reason })');
  });

  it('the helper is the only thing that awaits the alert for a refusal', () => {
    // One place decides whether an operator is told, so a new refusal branch
    // cannot reintroduce the flood by calling raiseFinancialAlert directly.
    //
    // PIN MOVED 2026-09-25, same commit as the mechanism it follows. This used
    // to assert the exact four-argument call
    // `raiseFinancialAlert(severity, source, message, context)`. The helper now
    // also passes a DURABLE subject key, because the in-memory `isNew` slot
    // this law pins is a per-process throttle and cannot be more than that:
    // 15,426 unresolved criticals accumulated on 1,003 already-settled
    // tournaments while every assertion in this file still passed. The law's
    // intent is unchanged and still enforced - one decision point, and it only
    // fires when isNew. See aSubjectKeyReachesTheDedupeDoor.law.test.ts.
    //
    // The window is bounded by the next member rather than a byte count: the
    // previous +700 was already smaller than the comment that documents this
    // branch, which is how a pin starts failing for prose (10.86 rule 4).
    const start = MANAGER.indexOf('protected async alertFinishRefusalOnce(');
    expect(start).toBeGreaterThan(-1);
    const after = MANAGER.indexOf('BUST_REFUSAL_SKIP_AFTER', start);
    const helper = MANAGER.slice(start, after > start ? after : start + 4000);
    expect(helper).toContain('await raiseFinancialAlert(');
    expect(helper).toContain('if (isNew)');
    // and it is still the ONLY awaited alert inside the helper
    expect(helper.match(/await raiseFinancialAlert\(/g) ?? []).toHaveLength(1);
  });

  it('an unproven outcome is always news, because it is never repeated on a clock', () => {
    const note = MANAGER.slice(
      MANAGER.indexOf('protected noteFinishRefusal('),
      MANAGER.indexOf('protected noteFinishRefusal(') + 600
    );
    expect(note).toContain('if (!provenRefusal) return true;');
  });
});
