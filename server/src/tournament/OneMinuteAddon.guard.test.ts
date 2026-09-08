import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const manager = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const closeMigration = readFileSync(
  join(
    process.cwd(),
    '../supabase/migrations/20260907180000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
  ),
  'utf8'
);
const gameServer = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');

describe('the MTT add-on is one persisted deadline', () => {
  const open = sliceMethod(manager, 'triggerAddOnPeriod(): Promise<void>');
  const schedule = sliceMethod(
    manager,
    'scheduleAddOnPeriodEnd(endsAt: string | null | undefined): void'
  );
  const arm = sliceMethod(manager, 'armAddOnPeriodEndCheck(delayMs: number): void');
  const drive = sliceMethod(
    manager,
    'drivePersistedAddOnDeadline(rebroadcastAfterThaw: boolean): Promise<void>'
  );
  const resync = sliceMethod(manager, 'resyncAddOnPeriodAfterMaintenanceThaw(): Promise<void>');
  const offer = sliceMethod(manager, 'tryTournamentAddOns(): Promise<void>');
  const finalize = sliceMethod(manager, 'finalizeAfterAddOn(): Promise<boolean>');
  const finishTail = sliceMethod(
    manager,
    'finishAddOnTail(finalPool: number, alreadyRepriced = false): Promise<void>'
  );
  const deadlineRetry = sliceMethod(manager, 'requestAddOnDeadlineRetry(delayMs: number): void');
  const thawRetry = sliceMethod(manager, 'scheduleAddOnResumeBroadcastRetry(): void');
  const stop = sliceMethod(manager, 'stop(): Promise<void>');
  const stopFence = sliceMethod(manager, 'applyStopFence(): Promise<void> | null');

  it('announces the exact persisted offer, price, chips, zero fee, and deadline', () => {
    expect(manager).toContain("message: 'The Add-On Period Has Begun'");
    expect(open).toContain('addOnFee: 0');
    expect(open).toContain('durationSeconds,');
    expect(open).toContain('endsAt,');
    expect(open).toMatch(/Math\.ceil\(\(endMs - Date\.now\(\)\) \/ 1000\)/);
  });

  it('persists and rearms the same deadline across a restart', () => {
    expect(manager).toContain('addon_period_started_at');
    expect(manager).toContain('addon_period_ends_at');
    expect(manager).toContain('this.scheduleAddOnPeriodEnd(tournament.addon_period_ends_at)');
  });

  it('treats a timer as a read edge, never as authority to close stale time', () => {
    expect(schedule).toContain('this.armAddOnPeriodEndCheck');
    expect(arm).toContain('this.addOnPeriodEndTimer = this.setLifecycleTimeout');
    expect(arm).toContain('this.drivePersistedAddOnDeadline(false)');
    expect(blankNonCode(arm)).not.toMatch(/\bsetTimeout\(/);
    expect(drive).toMatch(
      /\.from\('tournaments'\)[\s\S]*?addon_period_ends_at[\s\S]*?\.eq\('id', this\.tournamentId\)/
    );
    const reread = drive.indexOf(".from('tournaments')");
    const finalize = drive.indexOf('await this.finalizeAfterAddOn()');
    expect(reread).toBeGreaterThanOrEqual(0);
    expect(finalize).toBeGreaterThan(reread);
    expect(drive).toMatch(/remainingMs > 0[\s\S]*?this\.armAddOnPeriodEndCheck\(remainingMs\)/);
    const frozen = drive.lastIndexOf('if (isMaintenanceFrozen())', finalize);
    expect(frozen).toBeGreaterThan(reread);
    expect(frozen).toBeLessThan(finalize);
    expect(drive.slice(frozen, finalize)).toContain('return;');
    expect(drive.slice(frozen, finalize)).not.toContain('armAddOnPeriodEndCheck');

    // A failed durable read retains the exact causal edge through the shared
    // process scheduler; it never creates one polling timer per manager.
    expect(deadlineRetry).toContain('this.requestUrgentEliminationSweepAfter(delay)');
    expect(deadlineRetry).toContain(
      'this.lastAddOnOfferAt = Date.now() - TournamentManagerBase.ADD_ON_RETRY_MS + delay'
    );
    expect(blankNonCode(deadlineRetry)).not.toMatch(/setTimeout|setInterval/);
  });

  it('re-broadcasts the shifted absolute deadline after the database thaw', () => {
    expect(resync).toContain('this.drivePersistedAddOnDeadline(true)');
    expect(drive).toContain("message: 'The Add-On Period Has Resumed'");
    expect(drive).toContain('resumedAfterMaintenance: true');
    expect(drive).toContain('endsAt,');
    expect(gameServer).toContain('await manager.resyncAddOnPeriodAfterMaintenanceThaw()');
    expect(drive).toMatch(
      /const delivered = await this\.broadcast\('ADDON_PERIOD_START'[\s\S]*?if \(delivered\)[\s\S]*?this\.scheduleAddOnResumeBroadcastRetry\(\)/
    );
    expect(manager).toContain('this.drivePersistedAddOnDeadline(true)');
    expect(thawRetry).toContain('this.addOnResumeBroadcastRetryAttempts >= 3');
    expect(thawRetry).toContain('this.addOnResumeBroadcastRetryTimer = this.setLifecycleTimeout');
    expect(thawRetry).toContain('this.drivePersistedAddOnDeadline(true)');
    expect(blankNonCode(thawRetry)).not.toMatch(/\bsetTimeout\(/);
    const resumedBroadcast = drive.indexOf("this.broadcast('ADDON_PERIOD_START'");
    const schedulerClock = drive.indexOf(
      'this.lastAddOnOfferAt = Date.now() - TournamentManagerBase.ADD_ON_RETRY_MS',
      resumedBroadcast
    );
    const schedulerWake = drive.indexOf('this.requestEliminationSweep()', schedulerClock);
    const schedulerRetry = drive.indexOf('this.scheduleAddOnRetry()', schedulerWake);
    expect(schedulerClock).toBeGreaterThan(resumedBroadcast);
    expect(schedulerWake).toBeGreaterThan(schedulerClock);
    expect(schedulerRetry).toBeGreaterThan(schedulerWake);
    expect(drive).not.toContain('this.tryTournamentAddOns(');
    const thawDone = gameServer.indexOf('[MaintenanceBreak] thaw: complete');
    const resyncCall = gameServer.indexOf('await manager.resyncAddOnPeriodAfterMaintenanceThaw()');
    expect(resyncCall).toBeGreaterThan(thawDone);
  });

  it('retains thaw re-broadcast intent through a transient durable-read failure', () => {
    const readFailure = drive.indexOf('if (error || !state)');
    const nextBranch = drive.indexOf('if (state.prize_pool_finalized === true)', readFailure);
    const failureTail = drive.slice(readFailure, nextBranch);
    expect(readFailure).toBeGreaterThanOrEqual(0);
    expect(failureTail).toContain('this.requestAddOnDeadlineRetry(5_000)');
    expect(failureTail).toMatch(
      /if \(rebroadcastAfterThaw\) this\.scheduleAddOnResumeBroadcastRetry\(\)/
    );
    expect(failureTail).not.toContain('this.armAddOnPeriodEndCheck(5_000)');
  });

  it('owns only one close timer and clears it on stop', () => {
    expect(manager).toContain('private addOnPeriodEndTimer: NodeJS.Timeout | null = null');
    expect(arm).toContain(
      'if (this.addOnPeriodEndTimer) this.clearLifecycleTimeout(this.addOnPeriodEndTimer)'
    );
    expect(stop).toContain('this.applyStopFence()');
    expect(stopFence).toContain('this.clearLifecycleTimers()');
    expect(stopFence).toMatch(
      /this\.addOnPeriodEndTimer,[\s\S]*?this\.addOnResumeBroadcastRetryTimer,/
    );
    expect(stopFence).toMatch(
      /this\.addOnPeriodEndTimer = null;[\s\S]*?this\.addOnResumeBroadcastRetryTimer = null;/
    );
  });

  it('moves no automatic add-on or guarantee money during maintenance', () => {
    const offerGate = offer.indexOf('isMaintenanceFrozen()');
    expect(offerGate).toBeGreaterThanOrEqual(0);
    expect(offerGate).toBeLessThan(offer.indexOf(".from('tournament_players')"));
    expect(offer).toMatch(
      /for \(const h of horseRows\) \{[\s\S]*?if \(isMaintenanceFrozen\(\) \|\| !this\.eliminationMutationAllowed\(\)\) return;[\s\S]*?process_tournament_rebuy/
    );
    const finalFreeze = finalize.indexOf('if (isMaintenanceFrozen()) return false;');
    const closeRpc = finalize.indexOf("supabase.rpc('fn_close_tournament_addon_period'");
    expect(finalFreeze).toBeGreaterThanOrEqual(0);
    expect(closeRpc).toBeGreaterThan(finalFreeze);
    expect(finishTail).toMatch(
      /if \(!lifecycle \|\| !this\.lifecycleIsCurrent\(lifecycle\) \|\| isMaintenanceFrozen\(\)\) return;/
    );
    expect(finishTail.match(/isMaintenanceFrozen\(\)/g) ?? []).toHaveLength(3);
  });

  it('keeps the durable finalization edge after an atomic-close refusal', () => {
    const closeRpc = finalize.indexOf("supabase.rpc('fn_close_tournament_addon_period'");
    const refusal = finalize.indexOf('if (error || result.ok !== true)', closeRpc);
    const exactDeadline = finalize.indexOf('this.scheduleAddOnPeriodEnd(result.ends_at)', refusal);
    const durableRetry = finalize.indexOf('this.requestAddOnDeadlineRetry(5_000)', refusal);
    const tail = finalize.indexOf('await this.finishAddOnTail(finalPool, true)', refusal);
    expect(closeRpc).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThan(closeRpc);
    expect(exactDeadline).toBeGreaterThan(refusal);
    expect(durableRetry).toBeGreaterThan(exactDeadline);
    expect(tail).toBeGreaterThan(durableRetry);
    expect(finalize).not.toContain("applyPrizeGuarantee('addon_period_end')");
    expect(finalize).not.toContain('this.armAddOnPeriodEndCheck(5_000)');
  });

  it('serializes purchases against one atomic guarantee-funded close', () => {
    expect(manager).toContain("supabase.rpc('fn_close_tournament_addon_period'");
    expect(manager).not.toMatch(
      /finalizeAfterAddOn[\s\S]*?update\(\{ prize_pool_finalized: true \}\)[\s\S]*?applyPrizeGuarantee/
    );
    expect(finalize).toContain('const finalPool = Number(result.prize_pool)');
    expect(finalize).toContain('this.tournamentCache.prize_pool_finalized = true');
    expect(drive).toContain('if (state.prize_pool_finalized === true)');
    expect(drive).toContain('await this.finishAddOnTail(durablePool)');
    const fn = closeMigration.slice(
      closeMigration.indexOf('CREATE OR REPLACE FUNCTION public.fn_close_tournament_addon_period'),
      closeMigration.indexOf('REVOKE ALL ON FUNCTION public.fn_claim_tournament_bounty_elimination')
    );
    expect(fn).toContain('FOR UPDATE');
    expect(fn).toContain('clock_timestamp()<v_t.addon_period_ends_at');
    expect(fn).toContain('public.fn_apply_prize_guarantee');
    expect(fn.indexOf('public.fn_apply_prize_guarantee')).toBeLessThan(
      fn.indexOf('COALESCE(v_final.prize_pool_finalized,false)')
    );
    expect(fn).not.toContain('SET prize_pool_finalized=true');
  });
});
