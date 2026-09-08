import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const BASE = readFileSync(
  resolve(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

describe('tournament table engines recover from their causal generation signal', () => {
  it('does not depend on a later polling sweep to notice a dead or missing dealer', () => {
    expect(BASE).not.toContain('protected startTableLivenessSweep');
    expect(BASE).not.toContain('protected async reviveDeadTableEngines');
    expect(BASE).not.toContain('protected async adoptEnginelessTables');
    expect(BASE).not.toContain('protected tableLivenessInterval');
  });

  it('wires runtime death and the between-hands edge on every generation', () => {
    const wire = sliceMethod(BASE, 'wireEliminationWake(engine: ServerTableEngine)');
    expect(wire).toContain('engine.onRestartRequired((reason) =>');
    expect(wire).toContain('engine.onPauseReady(() => this.advanceHandForHandBarrier())');
    expect(wire).toContain('this.tableIdForManagedEngine(engine)');
    expect(wire).toContain('this.trackLifecycleJob(recovery)');

    const constructions = BASE.match(/this\.createManagedTableEngine\(/g) ?? [];
    const bindings = BASE.match(/this\.wireEliminationWake\(/g) ?? [];
    expect(bindings).toHaveLength(constructions.length);
  });

  it('deduplicates only a live exact-generation recovery and permits a real retry', () => {
    const recover = sliceMethod(BASE, 'private async recoverManagedTableEngine(');
    expect(BASE).toContain(
      'private readonly tableEngineRecoveries = new WeakMap<ServerTableEngine, Promise<void>>()'
    );
    expect(recover).toContain('this.tableEngineRecoveries.get(engine)');
    expect(recover).toContain('this.tableEngineRecoveries.set(engine, tracked)');
    expect(recover).toContain('this.tableEngineRecoveries.delete(engine)');
  });

  it('tears down and identity-replaces before publishing a successor', () => {
    const perform = sliceMethod(BASE, 'private async performManagedTableEngineRecovery(');
    const replaceAt = perform.indexOf('await this.gameServer.replaceTableEngine(');
    const staleAt = perform.indexOf('!this.lifecycleIsCurrent(lifecycle)', replaceAt);
    const publishAt = perform.indexOf('this.tableEngines.set(tableId, fresh)', staleAt);
    const startAt = perform.indexOf('this.startManagedTableEngine(fresh', publishAt);
    expect(replaceAt).toBeGreaterThan(-1);
    expect(staleAt).toBeGreaterThan(replaceAt);
    expect(publishAt).toBeGreaterThan(staleAt);
    expect(startAt).toBeGreaterThan(publishAt);
    expect(perform).toContain('this.tableEngines.get(tableId) !== engine');
  });

  it('inherits break and hand-for-hand holds before a replacement can start', () => {
    const prepare = sliceMethod(BASE, 'private prepareManagedTableEngineForPlay(');
    expect(prepare).toContain('if (this.onBreak)');
    expect(prepare).toContain('beforeNextHand: true');
    expect(prepare).toContain('if (this.handForHandActive) engine.pauseAfterHand()');

    const perform = sliceMethod(BASE, 'private async performManagedTableEngineRecovery(');
    expect(perform.indexOf('this.prepareManagedTableEngineForPlay(fresh)')).toBeLessThan(
      perform.indexOf('await this.gameServer.replaceTableEngine(')
    );
  });

  it('advances hand-for-hand from the final real pause edge, never an interval', () => {
    const barrier = sliceMethod(BASE, 'private advanceHandForHandBarrier()');
    expect(barrier).toContain('engines.some((engine) => !engine)');
    expect(barrier).toContain('engines.every((engine) => engine!.isWaitingForHandForHand())');
    expect(barrier).toContain('for (const engine of engines) engine!.resumeDealing()');
    expect(barrier).toContain('this.setLifecycleTimeout(() =>');
    expect(barrier).not.toContain('setLifecycleInterval');
    expect(BASE).not.toContain('handForHandSyncInterval');
  });

  it('keeps a pre-existing recovery in the hand-for-hand roster until durable retirement', () => {
    const start = sliceMethod(BASE, 'protected startHandForHandSync()');
    const schedule = sliceMethod(BASE, 'private scheduleManagedTableEngineRecovery(');
    const retire = sliceMethod(BASE, 'protected retireManagedTableFromHandForHand(');
    const admit = sliceMethod(BASE, 'private async admitMissingManagedTableEngine(');

    expect(start).toContain('this.tableEngineRecoveryAttempts.keys()');
    expect(schedule).toContain('this.handForHandTableIds.add(tableId)');
    expect(retire).toContain('this.handForHandTableIds.delete(tableId)');
    expect(retire).toContain('this.advanceHandForHandBarrier()');
    expect(admit).toContain('this.retireManagedTableFromHandForHand(tableId)');
  });

  it('cancels every causal retry before manager teardown can yield', () => {
    const fence = sliceMethod(BASE, 'private applyManagerMutationFence(');
    const stop = sliceMethod(BASE, 'stop(): Promise<void>');
    const abortAt = fence.indexOf('this.lifecycleEpoch.abort()');
    const clearAt = fence.indexOf('this.clearManagedTableEngineRecoveries()');
    expect(abortAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(abortAt);
    expect(fence).not.toContain('await ');
    expect(stop).toContain('const lifecycleOperation = this.applyStopFence();');
  });
});
