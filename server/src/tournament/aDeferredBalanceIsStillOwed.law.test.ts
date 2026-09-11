/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A BALANCE THE FREEZE DEFERRED IS STILL OWED (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The elimination sweep skips seat movement (balance and expansion) while the
 * platform is frozen for the hourly maintenance break - correctly, see
 * theFreezeIsTotal.law.test.ts. It then marked those stages complete and asked
 * for nothing. A field spread one player per table deals no hand and records
 * no bust, so nothing else wakes its manager: `$100 Freeroll 12:00 PM`
 * (7aa16fa7) recorded its last busts at 07:56:57 and 07:57:00 UTC, inside the
 * 07:53 freeze, and then sat as four players on four tables. A restart inside
 * a freeze sends every resumed manager's first sweep down the same exit.
 *
 * The pins: both stages re-arm through the sweep scheduler (one pending wake
 * per tournament, never a timer of their own) when the freeze made them skip,
 * and the wake follows the actual thaw without a wall-clock assumption.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const ELIM = readFileSync(resolve(__dirname, './TournamentManagerEliminations.ts'), 'utf8');

describe('a balance the freeze deferred is still owed', () => {
  it('the frozen branch of the balance stage asks for another pass after the thaw', () => {
    const stage = sliceEnclosingBlock(
      ELIM,
      'if (this.eliminationSweepCursor.nextStage > 5) break balanceStage;'
    );
    expect(stage).toContain('await this.checkTableBalance();');
    const guard = stage.indexOf('if (!isMaintenanceFrozen()) {');
    const elseAt = stage.indexOf('} else {', guard);
    const rearm = stage.indexOf('this.owePassAfterTheThaw();', elseAt);
    const complete = stage.indexOf('if (completedStage(6)) return;');
    expect(guard, 'the balance call must stay behind the freeze guard').toBeGreaterThan(-1);
    expect(elseAt, 'the frozen case needs its own branch').toBeGreaterThan(guard);
    expect(rearm, 'the frozen branch must re-arm the sweep').toBeGreaterThan(elseAt);
    expect(complete, 'the re-arm must happen before the stage is marked done').toBeGreaterThan(
      rearm
    );
  });

  it('the expansion stage re-arms the same way when the freeze skipped it', () => {
    const stage = sliceEnclosingBlock(
      ELIM,
      'if (this.eliminationSweepCursor.nextStage > 6) break expansionStage;'
    );
    expect(stage).toContain(
      'if (!isMaintenanceFrozen() && !(await this.checkDynamicTableExpansion())) return;'
    );
    const rearm = stage.indexOf('if (isMaintenanceFrozen()) this.owePassAfterTheThaw();');
    expect(rearm).toBeGreaterThan(-1);
    expect(stage.indexOf('if (completedStage(7)) return;')).toBeGreaterThan(rearm);
  });

  it('a balance the sweep budget cut short is re-entered once, then owed to the next cycle', () => {
    const stage = sliceEnclosingBlock(
      ELIM,
      'if (this.eliminationSweepCursor.nextStage > 5) break balanceStage;'
    );
    const call = stage.indexOf('await this.checkTableBalance();');
    const expired = stage.indexOf('if (this.eliminationWorkBudgetExpired()) {', call);
    expect(expired, 'the budget is checked after the balance ran').toBeGreaterThan(call);
    const retry = sliceEnclosingBlock(stage, 'this.balanceRetriedThisCycle = true;');
    expect(retry).toContain('this.requestEliminationSweep();');
    expect(retry, 'the retry yields without marking the stage complete').toMatch(/return;\s*\}$/);
    expect(stage.indexOf('this.balanceOwedAfterCycle = true;', expired)).toBeGreaterThan(expired);
    // Only the cycle boundary clears the one-retry allowance, and a debt still
    // outstanding there asks for a new cycle through the scheduler.
    const reset = sliceEnclosingBlock(ELIM, 'this.eliminationSweepCursor.reset();');
    const at = reset.indexOf('this.eliminationSweepCursor.reset();');
    expect(reset.indexOf('this.balanceRetriedThisCycle = false;', at)).toBeGreaterThan(at);
    const owed = sliceEnclosingBlock(reset, 'this.balanceOwedAfterCycle = false;');
    expect(owed).toContain(
      'this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);'
    );
  });

  it('never re-arms with a timer of its own', () => {
    for (const anchor of [
      'if (this.eliminationSweepCursor.nextStage > 5) break balanceStage;',
      'if (this.eliminationSweepCursor.nextStage > 6) break expansionStage;',
    ]) {
      const stage = sliceEnclosingBlock(ELIM, anchor);
      expect(stage).not.toMatch(/setTimeout\(|setInterval\(/);
    }
  });

  it('the selected redrive uses only one lifecycle-owned thaw subscription', () => {
    const arm = sliceEnclosingBlock(ELIM, 'const cancel = onNextMaintenanceThaw(');
    expect(arm).toContain('this.thawPass?.generation === lifecycle.generation');
    expect(arm).toContain('lifecycle.signal');
    expect(arm).toContain('this.lifecycleIsCurrent(lifecycle)');
    expect(arm).toContain('this.requestUrgentEliminationSweepAfter(');
    expect(ELIM).not.toContain('msUntilMaintenanceResume');
  });
});
