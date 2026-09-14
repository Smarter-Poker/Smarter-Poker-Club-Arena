import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
const ELIMINATIONS = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
const SERVER = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');

describe('one tournament lifecycle generation owns every continuation', () => {
  it('binds delayed callbacks and scheduler jobs to the exact lifecycle token', () => {
    expect(BASE).toContain('private readonly lifecycleEpoch = new TournamentLifecycleEpoch();');
    expect(BASE).toContain('if (!this.lifecycleIsCurrent(token)) return;');
    expect(BASE).toContain('isActive: () => this.lifecycleIsCurrent(lifecycle)');
    expect(BASE).toContain('await this.drainEliminationSchedulerJobs();');
    expect(BASE).toContain('await this.drainLifecycleJobs();');

    // Raw callback timers live only inside the two epoch-binding factories.
    // Promise backoff sleeps are not callbacks that retain manager ownership.
    expect(BASE.match(/const timer = setTimeout\(/g)).toHaveLength(1);
    expect(BASE.match(/const timer = setInterval\(/g)).toHaveLength(1);
  });

  it('aborts first, stops dealers to unblock startup, then drains and releases ownership', () => {
    const fence = sliceMethod(BASE, 'private applyManagerMutationFence(');
    const stopFence = sliceMethod(BASE, 'private applyStopFence()');
    const stop = sliceMethod(BASE, 'stop(): Promise<void>');
    const abortAt = fence.indexOf('this.lifecycleEpoch.abort();');
    const applyFenceAt = stop.indexOf('this.applyStopFence();');
    const schedulerDrainAt = stop.indexOf('await this.drainEliminationSchedulerJobs();');
    const jobDrainAt = stop.indexOf('await this.drainLifecycleJobs();');
    const engineStopAt = stop.indexOf('engine.stop()');
    const unregisterAt = stop.indexOf('this.gameServer.unregisterTournamentTableEngine(');

    expect(abortAt).toBeGreaterThan(0);
    expect(fence).not.toContain('await ');
    expect(stopFence).toContain('return this.applyManagerMutationFence(true);');
    expect(applyFenceAt).toBeGreaterThan(0);
    expect(engineStopAt).toBeGreaterThan(applyFenceAt);
    expect(schedulerDrainAt).toBeGreaterThan(engineStopAt);
    expect(jobDrainAt).toBeGreaterThan(schedulerDrainAt);
    expect(unregisterAt).toBeGreaterThan(engineStopAt);
    expect(stop).toContain('await this.drainTableEngineRunJobs();');
    expect(stop).toContain("if (result.status === 'rejected')");
    expect(stop).toContain('throw new AggregateError(');
  });

  it('owns every detached persistence write until teardown drains it', () => {
    expect(BASE).not.toContain('void Promise.resolve(');
    for (const mutation of [
      'update({ first_button_seat: seat })',
      'update({ level_started_at: new Date(this.blindTimerStartedAt).toISOString() })',
    ]) {
      const mutationAt = BASE.indexOf(mutation);
      expect(mutationAt).toBeGreaterThan(0);
      expect(BASE.slice(Math.max(0, mutationAt - 500), mutationAt)).toContain(
        'void this.trackLifecycleJob('
      );
    }

    // The add-on CAS is not detached: its caller awaits this whole method. It
    // therefore owns an explicit generation token across both the possibly
    // committed write response and the authoritative read-back.
    expect(sliceMethod(BASE, 'triggerAddOnPeriod(): Promise<void>')).toContain(
      'this.triggerAddOnPeriodOnce()'
    );
    const trigger = sliceMethod(BASE, 'triggerAddOnPeriodOnce(): Promise<void>');
    const token = trigger.indexOf('const lifecycle = this.captureLifecycleToken()');
    const mutationAt = trigger.indexOf('addon_period_triggered: true', token);
    const writeReceipt = trigger.indexOf('.select(projection)', mutationAt);
    const readBack = trigger.indexOf('.select(projection)', writeReceipt + 1);
    const fenceOffset = trigger
      .slice(readBack)
      .search(
        /if \(!this\.lifecycleIsCurrent\(lifecycle\)(?: \|\| this\.operationFinancialHeld\(\))?\) return;/
      );
    const fence = fenceOffset < 0 ? -1 : readBack + fenceOffset;
    expect(token).toBeGreaterThanOrEqual(0);
    expect(mutationAt).toBeGreaterThan(token);
    expect(writeReceipt).toBeGreaterThan(mutationAt);
    expect(readBack).toBeGreaterThan(writeReceipt);
    expect(fence).toBeGreaterThan(readBack);
    expect(trigger).not.toContain('void this.trackLifecycleJob(');
    expect(BASE).not.toContain('void this.triggerAddOnPeriod()');
  });

  it('never performs an unowned manager-map delete or overwrites after an awaited lease claim', () => {
    expect(SERVER).not.toContain('this.tournamentEngines.delete(');
    expect(SERVER).toContain('const stopped = await stopOwnedTournamentManager(');
    expect(SERVER).toContain('await releaseTournaments([{ tournamentId, leaseGeneration }])');
    expect(SERVER).toContain('return unregisterOwnedTournamentTableEngine(');
    expect(SERVER).toContain('if (this.tournamentEngines.has(tournament.id)) continue;');
    expect(SERVER.match(/finishTournamentManagerAdmission\(/g) ?? []).toHaveLength(2);
    expect(SERVER.match(/new TournamentManager\(/g) ?? []).toHaveLength(1);
  });

  it('admits or replaces table-engine generations without an overlapping stop', () => {
    const registration = SERVER.slice(
      SERVER.indexOf('registerTableEngine('),
      SERVER.indexOf('async replaceTableEngine(')
    );
    const replacement = SERVER.slice(
      SERVER.indexOf('async replaceTableEngine('),
      SERVER.indexOf('unregisterTournamentTableEngine(')
    );

    expect(registration).toContain('admitOwnedTableEngine(');
    expect(registration).toContain('return false;');
    expect(registration).not.toContain('void prev.stop()');
    expect(replacement).toContain('await replaceOwnedTableEngine(');
    expect(BASE.match(/this\.gameServer\.registerTableEngine\(/g)).toHaveLength(1);
    expect(BASE).toContain('this.admitManagedTableEngine(tableId, engine);');
    expect(BASE).toContain('await this.gameServer.replaceTableEngine(tableId, engine, fresh);');
  });

  it('does not self-deadlock when a scheduler finish initiates async teardown', () => {
    const cleanup = sliceMethod(ELIMINATIONS, 'cleanupCommittedTablesAndManager(');
    const enginesReleased = cleanup.indexOf('this.tableEngines.clear()');
    const detachedStop = cleanup.indexOf('void this.stop().catch', enginesReleased);
    expect(cleanup).not.toContain('await this.stop()');
    expect(enginesReleased).toBeGreaterThanOrEqual(0);
    expect(detachedStop).toBeGreaterThan(enginesReleased);
    expect(cleanup.match(/void this\.stop\(\)\.catch/g) ?? []).toHaveLength(1);
  });

  it('lets the server fence manager mutations before its graceful dealer drain', () => {
    const publicFence = sliceMethod(BASE, 'fenceForServerShutdown(): void');
    expect(publicFence).toContain('this.applyStopFence();');
    expect(publicFence).not.toContain('engine.stop()');
  });
});
