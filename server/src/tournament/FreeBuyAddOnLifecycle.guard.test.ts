import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const manager = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

describe('the Free Buy add-on is one durable lifecycle', () => {
  const start = sliceMethod(
    manager,
    'startLifecycle(lifecycle: TournamentLifecycleToken): Promise<void>'
  );
  const resume = sliceMethod(
    manager,
    'resumeLifecycle(lifecycle: TournamentLifecycleToken): Promise<void>'
  );
  const stop = sliceMethod(manager, 'stop(): Promise<void>');
  const mutationFence = sliceMethod(
    manager,
    'applyManagerMutationFence(clearLeaseExpiry: boolean): Promise<void> | null'
  );
  const trigger = sliceMethod(manager, 'triggerAddOnPeriod(): Promise<void>');
  const offer = sliceMethod(manager, 'tryTournamentAddOns(): Promise<void>');
  const breakStart = sliceMethod(manager, 'addOnBreakStartMs(endsAt: string | null | undefined)');
  const scheduleBreak = sliceMethod(
    manager,
    'scheduleAddOnBreak(endsAt: string | null | undefined): void'
  );
  const beginBreak = sliceMethod(manager, 'beginAddOnBreak(endMs: number): Promise<void>');
  const finishBreak = sliceMethod(manager, 'finishAddOnBreak(): Promise<void>');
  const drive = sliceMethod(
    manager,
    'drivePersistedAddOnDeadline(rebroadcastAfterThaw: boolean): Promise<void>'
  );
  const replay = sliceMethod(manager, 'scheduleFinalizedAddOnTailReplay(finalPool: number): void');
  const finalTail = sliceMethod(
    manager,
    'finishAddOnTail(finalPool: number, alreadyRepriced = false): Promise<void>'
  );

  it('never opens from seating and requires the committed entry boundary', () => {
    expect(start).not.toContain('await this.triggerAddOnPeriod()');
    expect(trigger).toContain('!this.tournamentEntryWindowClosed');
    expect(trigger).toContain('if (!this.areAllTablesParked()) return');
  });

  it('persists one full minute after every dealer parks, also for Free Buy', () => {
    expect(trigger).toContain(
      'const requestedEndMs = requestedStartMs + this.addOnBreakDurationMs()'
    );
    expect(trigger).not.toContain('const fromStart');
    expect(trigger).toContain('addon_period_started_at: requestedStart');
    expect(trigger).toContain('addon_period_ends_at: requestedEnd');
    expect(breakStart).toMatch(/endMs - this\.addOnBreakDurationMs\(\)/);
    expect(scheduleBreak).toContain('const breakStartMs = this.addOnBreakStartMs(endsAt)');
  });

  it('reconstructs both close and break exclusively from the persisted deadline', () => {
    const latch = trigger.indexOf('this.addOnPeriodTriggered = true');
    const close = trigger.indexOf('this.scheduleAddOnPeriodEnd(endsAt)', latch);
    const addOnBreak = trigger.indexOf('this.scheduleAddOnBreak(endsAt)', close);
    expect(latch).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(latch);
    expect(addOnBreak).toBeGreaterThan(close);

    expect(drive).toContain('this.scheduleAddOnBreak(endsAt)');
    expect(scheduleBreak).toMatch(
      /breakStartMs <= Date\.now\(\)[\s\S]*?this\.beginAddOnBreak\(endMs\)/
    );
    expect(scheduleBreak).toMatch(
      /this\.setLifecycleTimeout\([\s\S]*?this\.beginAddOnBreak\(endMs\)[\s\S]*?breakStartMs - Date\.now\(\)/
    );
    expect(blankNonCode(scheduleBreak)).not.toMatch(/\bsetTimeout\(/);
  });

  it('restores an in-progress break after engines and a synchronized break are restored', () => {
    const engineStart = resume.indexOf('await this.drainTableEngineStartJobs()');
    const synchronizedBreakRestore = resume.indexOf('if (tournament.on_break)');
    const durablePair = resume.indexOf('const validAddOnDeadline');
    const addOnBreakRestore = resume.indexOf(
      'this.scheduleAddOnBreak(tournament.addon_period_ends_at)',
      durablePair
    );

    expect(engineStart).toBeGreaterThanOrEqual(0);
    expect(synchronizedBreakRestore).toBeGreaterThan(engineStart);
    expect(durablePair).toBeGreaterThan(synchronizedBreakRestore);
    expect(addOnBreakRestore).toBeGreaterThan(durablePair);
    expect(resume).toMatch(
      /Number\.isFinite\(addOnStartedMs\)[\s\S]*?Number\.isFinite\(addOnEndsMs\)[\s\S]*?addOnEndsMs > addOnStartedMs/
    );
  });

  it('purchases only while the whole field is held, with no early tranche', () => {
    expect(manager).not.toContain('horseAddsOnImmediately');
    const hold = offer.indexOf('if (!this.addOnBreakHoldsTheField(Date.now())) return');
    expect(hold).toBeGreaterThanOrEqual(0);
    expect(offer.indexOf('this.offerAddOnsWhileTheFieldIsHeld(', hold)).toBeGreaterThan(hold);
    expect(beginBreak).toContain('this.scheduleAddOnRetry()');
    expect(beginBreak).toContain('this.requestEliminationSweep()');
  });

  it('offers only the still-playing, live-seated rows that have not consumed the boolean entitlement', () => {
    expect(offer).toMatch(/\.eq\('status', 'playing'\)/);
    expect(offer).toMatch(/\.filter\(\(r:[\s\S]*?\) => !r\.add_on\)/);
    expect(offer).toMatch(/\.is\('left_at', null\)/);
    expect(offer).toContain('withoutAddOn.filter((id) => seated.has(id))');
    expect(offer).toContain('this.offerAddOnsWhileTheFieldIsHeld(');
    expect(blankNonCode(resume)).not.toMatch(/add_on\s*[:=]\s*false/);
  });

  it('replays a finalized row after restart without requiring add_on_available to stay true', () => {
    const replayCall = resume.indexOf('this.scheduleFinalizedAddOnTailReplay(durablePool)');
    expect(replayCall).toBeGreaterThanOrEqual(0);
    const finalizedBranch = resume.lastIndexOf(
      'else if (this.prizePoolFinalized && validAddOnDeadline)',
      replayCall
    );
    expect(finalizedBranch).toBeGreaterThanOrEqual(0);
    expect(resume.slice(finalizedBranch, replayCall)).toMatch(
      /Number\.isFinite\(durablePool\) && durablePool >= 0/
    );
    expect(resume.slice(finalizedBranch, replayCall)).not.toMatch(/add_on_available/);
    expect(resume).not.toContain('await this.scheduleFinalizedAddOnTailReplay');
  });

  it('bounds the detached restart replay and can retry END after the in-memory final latch is set', () => {
    expect(replay).toContain('this.addOnFinalTailReplayAttempts >= 3');
    expect(replay).toContain('const attempt = ++this.addOnFinalTailReplayAttempts');
    expect(replay).toContain('this.addOnFinalTailReplayTimer = this.setLifecycleTimeout');
    expect(replay).toContain('await this.finishAddOnTail(finalPool)');
    expect(replay).toMatch(/catch \(error\)[\s\S]*?retry = true/);
    expect(replay).toContain('if (retry) this.scheduleFinalizedAddOnTailReplay(finalPool)');
    expect(blankNonCode(replay)).not.toMatch(/this\.prizePoolFinalized/);
    expect(blankNonCode(replay)).not.toMatch(
      /applyPrizeGuarantee|fn_apply_prize_guarantee|process_tournament_rebuy|supabase\.rpc/
    );
  });

  it('reprices, retries a lost END receipt, and releases the break without moving money', () => {
    const reprice = finalTail.indexOf('this.recalculateEliminatedPrizes(finalPool)');
    const end = finalTail.indexOf("const delivered = await this.broadcast('ADDON_PERIOD_END', {})");
    const releaseBreak = finalTail.indexOf('await this.finishAddOnBreak()', end);
    const clearClose = finalTail.indexOf(
      'this.clearLifecycleTimeout(this.addOnPeriodEndTimer)',
      releaseBreak
    );
    const failedReceipt = finalTail.indexOf('if (!delivered)', clearClose);

    expect(reprice).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(reprice);
    expect(releaseBreak).toBeGreaterThan(end);
    expect(clearClose).toBeGreaterThan(releaseBreak);
    expect(failedReceipt).toBeGreaterThan(clearClose);
    expect(blankNonCode(finalTail)).not.toMatch(
      /applyPrizeGuarantee|fn_apply_prize_guarantee|process_tournament_rebuy|supabase\.rpc/
    );
  });

  it('preserves pause ownership across either synchronized-break overlap direction', () => {
    const pause = sliceMethod(manager, 'pauseForBreak(breakDurationMs: number): Promise<void>');
    const resumeBreak = sliceMethod(manager, 'resumeFromBreak(): Promise<void>');

    expect(pause).toMatch(
      /if \([\s\S]*?!lifecycle[\s\S]*?!this\.lifecycleIsCurrent\(lifecycle\)[\s\S]*?this\.onBreak[\s\S]*?\) return/
    );
    expect(pause).toContain(
      'const addOnBreakAlreadyOwnsLevelClock = this.addOnBreakActive && this.addOnBreakOwnsLevelClock'
    );
    expect(pause).toContain('if (this.addOnBreakActive) this.addOnBreakOwnsPause = false');
    expect(pause).toContain('if (!addOnBreakAlreadyOwnsLevelClock) this.suspendLevelClock()');

    expect(resumeBreak).toContain(
      'const addOnBreakStillActive = this.addOnDrainPending || this.addOnBreakActive'
    );
    expect(resumeBreak).toMatch(
      /if \(addOnBreakStillActive\) \{[\s\S]*?this\.addOnBreakOwnsPause = true;[\s\S]*?this\.addOnBreakOwnsLevelClock = true;/
    );
    // Multi-day (2026-09-24): the stage-end pause is a fourth authority that
    // neither break end may lift. A successor drain owns the same gate until
    // this manager retires; both releases must preserve every authority.
    expect(resumeBreak).toMatch(
      /if \(\s*!this\.successorDrainRequested &&\s*!this\.handForHandActive &&\s*!addOnBreakStillActive &&\s*!this\.mysteryActivationBoundaryPending &&\s*!this\.stageEndPause\s*\)/
    );
    expect(resumeBreak).toContain('if (!addOnBreakStillActive && !this.stageEndPause) {');
    expect(finishBreak).toContain('if (!this.running) return');
    // A bubble can end during this break; its inherited gate must still release.
    // HandForHandBreakOwnership.test.ts exercises that transition with real engine pause methods.
    expect(finishBreak).toMatch(
      /if \(\s*!this\.successorDrainRequested &&\s*!this\.onBreak &&\s*!this\.handForHandActive &&\s*!this\.mysteryActivationBoundaryPending &&\s*!this\.stageEndPause\s*\)/
    );
    expect(finishBreak).toMatch(/if \(ownsLevelClock && !this\.onBreak && !this\.stageEndPause\)/);
  });

  it('adopts a shifted add-on break while maintenance still owns every dealer', () => {
    const frozen = beginBreak.indexOf('const maintenanceFrozen = isMaintenanceFrozen()');
    const absoluteHold = beginBreak.indexOf('engine.holdDealingUntil(endMs)', frozen);
    const frozenReturn = beginBreak.indexOf('if (maintenanceFrozen)', absoluteHold);
    const broadcast = beginBreak.indexOf("this.broadcast('addon_break'", frozenReturn);
    expect(frozen).toBeGreaterThanOrEqual(0);
    expect(absoluteHold).toBeGreaterThan(frozen);
    expect(frozenReturn).toBeGreaterThan(absoluteHold);
    expect(broadcast).toBeGreaterThan(frozenReturn);
    expect(beginBreak.slice(frozenReturn, broadcast)).toContain('return;');
    expect(beginBreak).toMatch(
      /if \(!this\.lifecycleIsCurrent\(lifecycle\) \|\| isMaintenanceFrozen\(\)\) return;/
    );
  });

  it('clears every add-on timer and pause latch on stop', () => {
    expect(stop).toContain('this.applyStopFence()');
    expect(mutationFence).toContain('this.clearLifecycleTimers()');
    for (const timer of [
      'addOnPeriodEndTimer',
      'addOnResumeBroadcastRetryTimer',
      'addOnBreakStartTimer',
      'addOnBreakEndTimer',
      'addOnFinalTailReplayTimer',
    ]) {
      expect(mutationFence).toContain(`this.${timer},`);
      expect(mutationFence).toContain(`this.${timer} = null`);
    }
    expect(mutationFence).toContain('this.addOnBreakActive = false');
    expect(mutationFence).toContain('this.addOnBreakEndsAtMs = 0');
    expect(mutationFence).toContain('this.addOnBreakOwnsLevelClock = false');
    expect(mutationFence).toContain('this.addOnBreakOwnsPause = false');
  });
});
