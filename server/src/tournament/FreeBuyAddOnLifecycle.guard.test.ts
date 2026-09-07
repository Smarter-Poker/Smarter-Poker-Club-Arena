import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const manager = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const freeBuy = readFileSync(join(process.cwd(), 'src/services/FreeBuy.ts'), 'utf8');

describe('the Free Buy add-on is one durable lifecycle', () => {
  const start = sliceMethod(manager, 'start(): Promise<void>');
  const resume = sliceMethod(manager, 'resume(): Promise<void>');
  const stop = sliceMethod(manager, 'stop(): void');
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

  it('opens after seating but before the pre-seat deal hold is applied', () => {
    const seatsExist = start.indexOf('await this.createTablesAndSeatPlayers(tournament)');
    const freeBuyOpen = start.indexOf('await this.triggerAddOnPeriod()', seatsExist);
    const advertisedDealHold = start.indexOf(
      "const scheduledStartMs = Date.parse(String(tournament.start_time ?? ''))",
      freeBuyOpen
    );

    expect(seatsExist).toBeGreaterThanOrEqual(0);
    expect(freeBuyOpen).toBeGreaterThan(seatsExist);
    expect(advertisedDealHold).toBeGreaterThan(freeBuyOpen);
    expect(start.slice(seatsExist, advertisedDealHold)).toMatch(
      /tournament\.addon_from_start && tournament\.add_on_available/
    );
  });

  it('anchors the break and close to advertised start plus late reg plus configured break', () => {
    expect(trigger).toContain('const requestedStart = new Date().toISOString()');
    expect(trigger).toContain(
      "const advertisedStartMs = Date.parse(String(this.tournamentCache?.start_time ?? ''))"
    );
    expect(trigger).toMatch(
      /const requestedEndMs = fromStart\s*\? advertisedStartMs \+ lateRegMs \+ this\.addOnBreakDurationMs\(\)\s*:\s*requestedStartMs \+ 60_000/
    );
    expect(trigger).toContain('addon_period_started_at: requestedStart');
    expect(trigger).toContain('addon_period_ends_at: requestedEnd');
    expect(trigger).not.toMatch(/\? requestedStartMs \+ lateRegMs/);

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
      /setTimeout\([\s\S]*?this\.beginAddOnBreak\(endMs\)[\s\S]*?breakStartMs - Date\.now\(\)/
    );
  });

  it('restores an in-progress break after engines and a synchronized break are restored', () => {
    const engineStart = resume.indexOf('.start()');
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

  it('gives the deterministic 35% tranche at opening and every remaining live horse at break', () => {
    expect(freeBuy).toContain('export const HORSE_ADDON_IMMEDIATE_RATE = 0.35');
    expect(manager).toContain("import { horseAddsOnImmediately } from '../services/FreeBuy.js'");
    expect(offer).toMatch(
      /if \(Date\.now\(\) < breakStartMs\)[\s\S]*?horseRows = horseRows\.filter[\s\S]*?horseAddsOnImmediately\(horse\.id, this\.tournamentId\)/
    );
    expect(beginBreak).toContain('await this.tryTournamentAddOns()');

    const split = offer.indexOf('if (Date.now() < breakStartMs)');
    const purchase = offer.indexOf("p_rebuy_type: 'addon'", split);
    expect(split).toBeGreaterThanOrEqual(0);
    expect(purchase).toBeGreaterThan(split);
    expect(offer.slice(split, purchase)).not.toMatch(/else\s+return/);
  });

  it('offers only the still-playing, live-seated rows that have not consumed the boolean entitlement', () => {
    expect(offer).toMatch(/\.eq\('status', 'playing'\)/);
    expect(offer).toMatch(/\.filter\(\(r:[\s\S]*?\) => !r\.add_on\)/);
    expect(offer).toMatch(/\.is\('left_at', null\)/);
    expect(offer).toContain('withoutAddOn.filter((id) => seated.has(id))');
    expect(offer).toContain("p_rebuy_type: 'addon'");
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
    expect(replay).toContain('this.addOnFinalTailReplayTimer = setTimeout');
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
    const clearClose = finalTail.indexOf('clearTimeout(this.addOnPeriodEndTimer)', releaseBreak);
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

    expect(pause).toContain('if (!this.running || this.onBreak) return');
    expect(pause).toContain(
      'const addOnBreakAlreadyOwnsPause = this.addOnBreakActive && this.addOnBreakOwnsPause'
    );
    expect(pause).toContain('if (this.addOnBreakActive) this.addOnBreakOwnsPause = false');
    expect(pause).toContain('if (!addOnBreakAlreadyOwnsPause) this.suspendLevelClock()');

    expect(resumeBreak).toContain('const addOnBreakStillActive = this.addOnBreakActive');
    expect(resumeBreak).toContain('if (addOnBreakStillActive) this.addOnBreakOwnsPause = true');
    expect(resumeBreak).toMatch(/if \(!this\.handForHandActive && !addOnBreakStillActive\)/);
    expect(resumeBreak).toContain('if (!addOnBreakStillActive) {');
    expect(finishBreak).toContain('if (!this.running || !ownsPause || this.onBreak) return');
  });

  it('clears every add-on timer and pause latch on stop', () => {
    for (const timer of [
      'addOnPeriodEndTimer',
      'addOnResumeBroadcastRetryTimer',
      'addOnBreakStartTimer',
      'addOnBreakEndTimer',
      'addOnFinalTailReplayTimer',
    ]) {
      expect(stop).toContain(`clearTimeout(this.${timer})`);
      expect(stop).toContain(`this.${timer} = null`);
    }
    expect(stop).toContain('this.addOnBreakActive = false');
    expect(stop).toContain('this.addOnBreakOwnsPause = false');
  });
});
