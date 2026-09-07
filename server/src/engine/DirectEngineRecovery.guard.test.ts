import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const GAME_SERVER = readFileSync(resolve(process.cwd(), 'src/GameServer.ts'), 'utf8');

const method = (name: string): string => sliceMethod(GAME_SERVER, name);

describe('direct table-engine terminal recovery', () => {
  it('binds every GameServer-owned engine generation before publishing it', () => {
    const constructions = [...GAME_SERVER.matchAll(/new ServerTableEngine\(/g)];
    const bindings = GAME_SERVER.match(/this\.wireDirectTableEngineRecovery\(/g) ?? [];
    expect(constructions).toHaveLength(2);
    expect(bindings).toHaveLength(constructions.length);

    for (const construction of constructions) {
      const start = construction.index ?? -1;
      const published = GAME_SERVER.indexOf('this.tableEngines.set(', start);
      const wired = GAME_SERVER.indexOf('this.wireDirectTableEngineRecovery(', start);
      expect(start).toBeGreaterThan(-1);
      expect(published).toBeGreaterThan(start);
      expect(wired).toBeGreaterThan(start);
      expect(wired).toBeLessThan(published);
    }
  });

  it('publishes a classified readiness promise for all three direct start paths', () => {
    const readiness = method('private trackDirectTableEngineReadiness(');
    expect(readiness).toContain('engine.ready.then<DirectTableAdmission>');
    expect(readiness).toContain('this.tableEngineStartPromises.set(tableId, tracked)');
    expect(readiness).toContain('this.tableEngineStartPromises.get(tableId) === tracked');
    expect(GAME_SERVER.match(/this\.trackDirectTableEngineReadiness\(/g) ?? []).toHaveLength(2);
  });

  it('tears down and compare-deletes the failed generation before readmission', () => {
    const recovery = method('private async performDirectTableEngineRecovery(');
    const owns = recovery.indexOf('this.tableEngines.get(tableId) !== engine');
    const teardown = recovery.indexOf('await engine.stop()');
    const compareAgain = recovery.indexOf('this.tableEngines.get(tableId) !== engine', owns + 1);
    const remove = recovery.indexOf('this.tableEngines.delete(tableId)');
    const readmit = recovery.indexOf('await this.ensureCashTableEngineAdmission(tableId)');

    expect(owns).toBeGreaterThan(-1);
    expect(teardown).toBeGreaterThan(owns);
    expect(compareAgain).toBeGreaterThan(teardown);
    expect(remove).toBeGreaterThan(compareAgain);
    expect(readmit).toBeGreaterThan(remove);
    expect(recovery).toContain('if (this.tournamentOwnedTables.has(tableId)) return;');
    expect(recovery).toContain('if (deferReadmission)');
    expect(recovery).toContain('this.scheduleDirectTableRecovery(tableId, reason);');
    expect(recovery).toContain('if (!engine.hasReleasedProcessOwnership()) throw error;');
    expect(recovery).not.toContain('setInterval(');
  });

  it('joins duplicate signals by engine identity without suppressing a successor generation', () => {
    const recovery = method('private async recoverDirectTableEngine(');
    expect(GAME_SERVER).toContain(
      'private directTableEngineRecoveries = new WeakMap<ServerTableEngine, Promise<void>>()'
    );
    expect(recovery).toContain('this.directTableEngineRecoveries.get(engine)');
    expect(recovery).toContain('this.directTableEngineRecoveries.set(engine, tracked)');
    expect(recovery).toContain('this.directTableEngineRecoveries.delete(engine)');
    expect(recovery).not.toContain('Map<string, Promise<void>>');
  });

  it('retains only classified transient failures as causal one-table retries', () => {
    const schedule = method('private scheduleDirectTableRecovery(');
    const finish = method('private finishDirectTableAdmission(');
    expect(schedule).toContain('this.directTableRecoveryTimers.has(tableId)');
    expect(schedule).toContain('this.ensureCashTableEngineAdmission(tableId)');
    expect(schedule).toContain("outcome === 'retryable_failure'");
    expect(schedule).toContain('timer.unref?.()');
    expect(schedule).toContain('15_000');
    expect(schedule).not.toContain('setInterval(');
    expect(finish).toContain("outcome === 'retryable_failure'");
    expect(finish).toContain('this.clearDirectTableRecovery(tableId)');
    expect(finish).not.toContain('releaseTables(');

    const admission = method('private async performCashTableEngineAdmission(');
    expect(admission).toContain('await releaseTables([tableId])');
    expect(admission).toContain('this.directAdmissionIsCurrent(generation)');
    const claimAt = admission.indexOf('await claimTableLease(tableId)');
    const releaseAt = admission.indexOf('await releaseTables([tableId])');
    expect(claimAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(claimAt);
  });

  it('classifies closure, foreign ownership, lookup failure and readiness separately', () => {
    const admission = method('private async performCashTableEngineAdmission(');
    expect(admission).toContain("return 'not_wakeable'");
    expect(admission).toContain("return 'owned_elsewhere'");
    expect(admission).toContain("return 'retryable_failure'");
    expect(admission).toContain("return 'ready'");
    expect(admission).toContain('racedEngine.isRunning()');
    expect(admission).toContain("lease.status === 'retryable_failure'");
    expect(admission).toContain("lease.status === 'owned_elsewhere'");
  });

  it('serializes lookup, claim and terminal release across concurrent admissions', () => {
    const admission = method('private async ensureCashTableEngineAdmission(');
    expect(GAME_SERVER).toContain(
      'private directTableAdmissionOperations = new Map<string, Promise<DirectTableAdmission>>()'
    );
    expect(admission).toContain('this.directTableAdmissionOperations.get(tableId)');
    expect(admission).toContain('this.directTableAdmissionOperations.set(tableId, tracked)');
    expect(admission).toContain('this.directTableAdmissionOperations.delete(tableId)');
  });

  it('routes both construction sites into recovery and discovery through the same admission', () => {
    for (const [signature, reason] of [
      ['private async startTableEngineForTesting(', 'test_start_failed'],
      ['private async performCashTableEngineAdmission(', 'direct_start_failed'],
    ] as const) {
      const constructionSite = method(signature);
      expect(constructionSite).toContain(
        `this.recoverDirectTableEngine(tableId, engine, '${reason}', true)`
      );
    }
    expect(GAME_SERVER).toContain('this.ensureCashTableEngineAdmission(row.table_id)');
    expect(method('private async discoverCashTables()')).toContain('this.launchDiscoveryJob(');
    expect(GAME_SERVER).not.toContain('GameServer.E2E_test_table_engine_stop_error');
    expect(GAME_SERVER).not.toContain('GameServer.Engine_start_cleanup_failed');
    expect(GAME_SERVER).not.toContain('GameServer.on_demand_table_start_cleanup_failed');
  });

  it('cancels every outstanding causal retry on server shutdown', () => {
    const stop = method('private async performStop(');
    expect(stop).toContain('for (const timer of this.directTableRecoveryTimers.values())');
    expect(stop).toContain('this.directTableRecoveryTimers.clear()');
    expect(stop).toContain('this.directTableRecoveryAttempts.clear()');
    expect(stop).toContain(
      'for (const timer of this.tournamentManagerAdmissionRetryTimers.values())'
    );
    expect(stop).toContain('this.tournamentManagerAdmissionRetryTimers.clear()');
  });

  it('joins discovery and every serialized admission before taking the shutdown snapshot', () => {
    const start = method('private async performStart(');
    const stopFence = method('stop(): Promise<void>');
    const stop = method('private async performStop(');
    expect(start.match(/this\.launchDiscoveryJob\(/g) ?? []).toHaveLength(3);
    for (const loop of [
      'private async discoverCashTables()',
      'private async discoverTournaments()',
      'private async discoverSeatFirstStarts()',
    ]) {
      expect(method(loop)).toContain('while (this.directAdmissionIsCurrent(generation))');
    }

    const fenceAt = stopFence.indexOf('manager.fenceForServerShutdown()');
    const externalFenceAt = stopFence.indexOf('this.beginExternalShutdownOwnershipBarrier()');
    const teardownAt = stopFence.indexOf(
      'this.performStop(tournamentManagersAtFence, externalOwnership)'
    );
    const firstAwaitAt = stop.indexOf('await ');
    const lifecycleDrainAt = stop.indexOf('await this.drainOwnedLifecycleJobs()');
    const snapshotAt = stop.indexOf('const engineTableIds = [...this.tableEngines.keys()]');
    expect(fenceAt).toBeGreaterThan(-1);
    expect(externalFenceAt).toBeGreaterThan(fenceAt);
    expect(teardownAt).toBeGreaterThan(externalFenceAt);
    expect(firstAwaitAt).toBeGreaterThan(-1);
    expect(lifecycleDrainAt).toBeGreaterThan(firstAwaitAt);
    expect(snapshotAt).toBeGreaterThan(lifecycleDrainAt);
    const unionDrain = method('private async drainOwnedLifecycleJobs()');
    for (const registry of [
      'this.serverLifecycleJobs',
      'this.discoveryJobs',
      'this.directTableAdmissionOperations.values()',
      'this.directTableEngineRecoveryJobs',
      'this.tournamentManagerAdmissionOperations.values()',
    ]) {
      expect(unionDrain).toContain(registry);
    }
  });

  it('serializes boot and teardown and fences every boot await', () => {
    const start = method('start(): Promise<void>');
    const boot = method('private async performStart(');
    const stop = method('stop(): Promise<void>');
    const teardown = method('private async performStop(');

    expect(start).toContain('if (this.startOperation) return this.startOperation;');
    expect(start).toContain('if (this.teardownPromise)');
    expect(stop).toContain('if (this.teardownPromise) return this.teardownPromise;');
    expect(stop).toContain('this.running = false;');
    expect(stop).toContain('this.lifecycleGeneration += 1;');
    expect(stop).toContain('manager.fenceForServerShutdown()');
    expect(
      boot.match(/this\.directAdmissionIsCurrent\(generation\)/g)?.length ?? 0
    ).toBeGreaterThan(5);
    expect(teardown).toContain('await this.startOperation.catch(');
    expect(teardown).toContain("beginOwnedStop('RakeSpecGuard', stopRakeSpecGuard)");
    expect(teardown).toContain(
      "beginOwnedStop('MaintenanceBreak', () => this.maintenanceBreak.stop())"
    );
    const supportFenceAt = teardown.indexOf('const firstSupportingStops = [');
    const bootJoinAt = teardown.indexOf('await this.startOperation.catch(');
    expect(supportFenceAt).toBeGreaterThan(-1);
    expect(supportFenceAt).toBeLessThan(bootJoinAt);
    expect(teardown).toContain("reportError(error, 'GameServer.supporting_shutdown_failed'");
    expect(teardown).toContain('this.clockSkewTimer = null;');
    const externalFailureAt = teardown.indexOf("externalOwnershipResult.status === 'rejected'");
    const releaseAt = teardown.indexOf('await releaseTables()');
    expect(externalFailureAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(externalFailureAt);
  });

  it('owns synchronized-break and slow-cleanup continuations until shutdown joins them', () => {
    const trigger = method('private async triggerSynchronizedBreak()');
    const resume = method('private async resumeSynchronizedBreak(');
    const cleanup = method('private async cleanupStaleData(');
    const schedule = method('private scheduleSynchronizedBreaks()');

    expect(schedule).toContain('this.launchServerLifecycleJob(');
    expect(schedule).toContain('this.triggerSynchronizedBreak()');
    expect(trigger).toContain('const generation = this.lifecycleGeneration;');
    expect(trigger).toContain('await this.waitForAllTablesParked(breakEngines)');
    expect(trigger).toContain('this.directAdmissionIsCurrent(generation)');
    expect(trigger).toContain('this.resumeSynchronizedBreak(breakEngines, generation)');
    expect(resume).toContain('if (!this.directAdmissionIsCurrent(generation)) return;');
    expect(cleanup).toContain('const cleanupGeneration = this.lifecycleGeneration;');
    expect(cleanup).toContain('this.launchServerLifecycleJob(');
    expect(cleanup).toContain('this.directAdmissionIsCurrent(cleanupGeneration)');
    expect(GAME_SERVER).not.toContain('void this.triggerSynchronizedBreak()');
  });

  it('constructs every tournament manager through one leased lifecycle admission', () => {
    expect(GAME_SERVER.match(/new TournamentManager\(/g) ?? []).toHaveLength(1);
    const admission = method('private async performTournamentManagerAdmission(');
    const claimAt = admission.indexOf('await claimTournamentLease(tournamentId)');
    const staleAt = admission.indexOf('!this.directAdmissionIsCurrent(generation)', claimAt);
    const releaseAt = admission.indexOf('await releaseTournaments([tournamentId])', staleAt);
    const constructAt = admission.indexOf('new TournamentManager(tournamentId, this)', releaseAt);
    expect(claimAt).toBeGreaterThan(-1);
    expect(staleAt).toBeGreaterThan(claimAt);
    expect(releaseAt).toBeGreaterThan(staleAt);
    expect(constructAt).toBeGreaterThan(releaseAt);
    expect(method('private async discoverTournaments()')).not.toContain('new TournamentManager(');
    expect(method('private async discoverSeatFirstStarts()')).not.toContain(
      'new TournamentManager('
    );

    const retry = method('private scheduleTournamentManagerAdmissionRetry(');
    expect(retry).toContain('this.tournamentManagerAdmissionRetryTimers.has(tournamentId)');
    expect(retry).toContain('this.ensureTournamentManagerAdmission(');
    expect(retry).toContain('timer.unref?.()');
    expect(retry).not.toContain('setInterval(');
    expect(admission).toContain("lease.status === 'retryable_failure'");
    expect(admission).toContain('this.scheduleTournamentManagerAdmissionRetry(');
    expect(
      admission.match(/await releaseTournaments\(\[tournamentId\]\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(3);
  });

  it('retains leadership and leases until every dealer and manager is stopped', () => {
    const stop = method('private async performStop(');
    const firstProducerFence = stop.indexOf('const firstProducerStops = beginOwnedProducerStops()');
    const bootJoin = stop.indexOf('await this.startOperation.catch(');
    const secondProducerFence = stop.indexOf('...beginOwnedProducerStops()');
    const producerFailureGate = stop.indexOf("result.status !== 'rejected'", secondProducerFence);
    const engineStop = stop.indexOf('const engineStops = engines.map((engine) => engine.stop())');
    const managerStop = stop.indexOf('const managerStops = tournamentManagers.map(');
    const ownershipGate = stop.indexOf('if (ownershipFailures.length > 0)');
    const tableRelease = stop.indexOf('await releaseTables();');
    const tournamentRelease = stop.indexOf('await releaseTournaments();');
    const leadershipRelease = stop.indexOf('await releaseLeadership();');

    expect(firstProducerFence).toBeGreaterThan(-1);
    expect(bootJoin).toBeGreaterThan(firstProducerFence);
    expect(secondProducerFence).toBeGreaterThan(bootJoin);
    expect(producerFailureGate).toBeGreaterThan(secondProducerFence);
    expect(engineStop).toBeGreaterThan(-1);
    expect(managerStop).toBeGreaterThan(engineStop);
    expect(ownershipGate).toBeGreaterThan(managerStop);
    expect(tableRelease).toBeGreaterThan(ownershipGate);
    expect(tournamentRelease).toBeGreaterThan(tableRelease);
    expect(leadershipRelease).toBeGreaterThan(tournamentRelease);
    expect(stop.indexOf('stopLeadershipRenewal()')).toBeGreaterThan(managerStop);

    for (const producer of [
      'HorseFleetManager',
      'ClusterController',
      'TournamentRecurringService',
      'ScheduledTournamentService',
      'HorseLifecycleManager',
      'DealRateVerifier',
      'RakebackSettlerService',
      'StatsHealthMonitor',
    ]) {
      expect(stop).toContain(`['${producer}',`);
    }
  });
});
