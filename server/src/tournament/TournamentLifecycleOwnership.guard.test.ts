import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

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
    const trigger = sliceMethod(BASE, 'triggerAddOnPeriod(): Promise<void>');
    const token = trigger.indexOf('const lifecycle = this.captureLifecycleToken()');
    const mutationAt = trigger.indexOf('addon_period_triggered: true', token);
    const writeReceipt = trigger.indexOf('.select(projection)', mutationAt);
    const readBack = trigger.indexOf('.select(projection)', writeReceipt + 1);
    const fence = trigger.indexOf('if (!this.lifecycleIsCurrent(lifecycle)) return;', readBack);
    expect(token).toBeGreaterThanOrEqual(0);
    expect(mutationAt).toBeGreaterThan(token);
    expect(writeReceipt).toBeGreaterThan(mutationAt);
    expect(readBack).toBeGreaterThan(writeReceipt);
    expect(fence).toBeGreaterThan(readBack);
    expect(trigger).not.toContain('void this.trackLifecycleJob(');
    expect(BASE).not.toContain('void this.triggerAddOnPeriod()');
  });

  it('never performs an unowned manager-map delete or overwrites after an awaited lease claim', () => {
    const transfer = sliceMethod(SERVER, 'private async transferDrainedF06Custody(');
    const code = blankNonCode(transfer);
    const firstCapture = code.indexOf('let packet = await manager.captureDrainedF06Custody();');
    const capture = code.indexOf('packet = await manager.captureMixedF06Custody(successor);');
    expect(firstCapture).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(firstCapture);
    const retain = code.indexOf('this.drainedF06TournamentCustody.set(tournamentId, packet);');
    const removeTables = code.indexOf('this.tableEngines.delete(id);');
    const removeManager = code.indexOf('this.tournamentEngines.delete(tournamentId);');

    // The sole direct deletion transfers stopped originals into retained custody.
    // Every identity is checked after capture and before any map changes, with no
    // intervening await that could let another manager replace the checked owner.
    expect(capture).toBeGreaterThanOrEqual(0);
    const admission = code.slice(capture, retain);
    for (const refusal of [
      '!packet ||',
      'packet.manager !== manager',
      'packet.tournamentId !== tournamentId',
      'this.tournamentEngines.get(tournamentId) !== manager',
      'this.drainedF06TournamentCustody.has(tournamentId)',
      '!packet.current()',
      '!completePhysicalMap()',
      'packet.engines.some(',
      'this.tableEngines.get(id) !== engine',
      '!this.tournamentRetirementCustody.admissionAllowed(id)',
      'return false;',
    ]) {
      expect(admission).toContain(refusal);
    }
    expect(retain).toBeGreaterThan(capture);
    expect(removeTables).toBeGreaterThan(retain);
    expect(removeManager).toBeGreaterThan(removeTables);
    expect(code.slice(capture + code.slice(capture).indexOf(';') + 1, removeManager)).not.toMatch(
      /\bawait\b/
    );
    expect(code.match(/this\.tournamentEngines\.delete\(/g)).toHaveLength(1);
    expect(blankNonCode(SERVER.replace(transfer, ''))).not.toContain(
      'this.tournamentEngines.delete('
    );
    expect(SERVER).toMatch(/(?:const|let) stopped = await stopOwnedTournamentManager\(/);
    expect(SERVER).toContain('await releaseTournaments([{ tournamentId, leaseGeneration }])');
    expect(SERVER).toContain('return unregisterOwnedTournamentTableEngine(');
    expect(SERVER).toContain('if (this.tournamentEngines.has(tournament.id)) continue;');
    expect(SERVER.match(/finishTournamentManagerAdmission\(/g) ?? []).toHaveLength(3);
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
