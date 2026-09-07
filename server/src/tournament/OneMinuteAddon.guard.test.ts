import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const manager = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
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
  const finalize = sliceMethod(manager, 'finalizeAfterAddOn(): Promise<void>');

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
    expect(arm).toContain('this.drivePersistedAddOnDeadline(false)');
    expect(drive).toMatch(
      /\.from\('tournaments'\)[\s\S]*?addon_period_ends_at[\s\S]*?\.eq\('id', this\.tournamentId\)/
    );
    const reread = drive.indexOf(".from('tournaments')");
    const finalize = drive.indexOf('await this.finalizeAfterAddOn()');
    expect(reread).toBeGreaterThanOrEqual(0);
    expect(finalize).toBeGreaterThan(reread);
    expect(drive).toMatch(/remainingMs > 0[\s\S]*?this\.armAddOnPeriodEndCheck\(remainingMs\)/);
    expect(drive).toMatch(
      /if \(isMaintenanceFrozen\(\)\)[\s\S]*?this\.armAddOnPeriodEndCheck\(5_000\)[\s\S]*?return/
    );
  });

  it('re-broadcasts the shifted absolute deadline after the database thaw', () => {
    expect(resync).toContain('this.drivePersistedAddOnDeadline(true)');
    expect(drive).toContain("message: 'The Add-On Period Has Resumed'");
    expect(drive).toContain('resumedAfterMaintenance: true');
    expect(drive).toContain('endsAt,');
    expect(drive).toMatch(
      /if \(isMaintenanceFrozen\(\)\)[\s\S]*?setTimeout\(offerAfterResume, 1_000\)[\s\S]*?this\.tryTournamentAddOns\(\)/
    );
    expect(gameServer).toContain('await manager.resyncAddOnPeriodAfterMaintenanceThaw()');
    expect(drive).toMatch(
      /const delivered = await this\.broadcast\('ADDON_PERIOD_START'[\s\S]*?if \(delivered\)[\s\S]*?this\.scheduleAddOnResumeBroadcastRetry\(\)/
    );
    expect(manager).toContain('this.drivePersistedAddOnDeadline(true)');
    expect(manager).toContain('this.addOnResumeBroadcastRetryAttempts >= 3');
    const thawDone = gameServer.indexOf('[MaintenanceBreak] thaw: complete');
    const resyncCall = gameServer.indexOf('await manager.resyncAddOnPeriodAfterMaintenanceThaw()');
    expect(resyncCall).toBeGreaterThan(thawDone);
  });

  it('retains thaw re-broadcast intent through a transient durable-read failure', () => {
    const readFailure = drive.indexOf('if (error || !state)');
    const nextBranch = drive.indexOf('if (state.prize_pool_finalized === true)', readFailure);
    const failureTail = drive.slice(readFailure, nextBranch);
    expect(readFailure).toBeGreaterThanOrEqual(0);
    expect(failureTail).toContain('this.armAddOnPeriodEndCheck(5_000)');
    expect(failureTail).toMatch(
      /if \(rebroadcastAfterThaw\) this\.scheduleAddOnResumeBroadcastRetry\(\)/
    );
  });

  it('owns only one close timer and clears it on stop', () => {
    expect(manager).toContain('private addOnPeriodEndTimer: NodeJS.Timeout | null = null');
    expect(manager).toMatch(
      /if \(this\.addOnPeriodEndTimer\) clearTimeout\(this\.addOnPeriodEndTimer\)/
    );
    const stop = sliceMethod(manager, 'stop(): void');
    expect(stop).toMatch(
      /clearTimeout\(this\.addOnPeriodEndTimer\)[\s\S]*?this\.addOnPeriodEndTimer = null/
    );
    expect(stop).toMatch(
      /clearTimeout\(this\.addOnResumeBroadcastRetryTimer\)[\s\S]*?this\.addOnResumeBroadcastRetryTimer = null/
    );
  });

  it('moves no automatic add-on or guarantee money during maintenance', () => {
    const offerGate = offer.indexOf('if (isMaintenanceFrozen()) return;');
    expect(offerGate).toBeGreaterThanOrEqual(0);
    expect(offerGate).toBeLessThan(offer.indexOf(".from('tournament_players')"));
    expect(offer).toMatch(
      /for \(const h of horseRows\) \{[\s\S]*?if \(isMaintenanceFrozen\(\)\) break;[\s\S]*?process_tournament_rebuy/
    );
    expect(finalize).toMatch(
      /if \(isMaintenanceFrozen\(\)\) \{[\s\S]*?armAddOnPeriodEndCheck\(5_000\)[\s\S]*?return;/
    );
  });

  it('keeps the durable finalization edge after a funding refusal', () => {
    const funding = finalize.indexOf("applyPrizeGuarantee('addon_period_end')");
    const retry = finalize.indexOf('if (finalPool === null)', funding);
    const close = finalize.indexOf('this.finishAddOnTail(finalPool, true)', funding);
    expect(funding).toBeGreaterThanOrEqual(0);
    expect(retry).toBeGreaterThan(funding);
    expect(finalize.slice(retry, close)).toContain('this.armAddOnPeriodEndCheck(5_000)');
    expect(close).toBeGreaterThan(retry);
  });
});
