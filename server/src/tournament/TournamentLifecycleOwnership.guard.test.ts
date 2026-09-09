import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';
import type { GameServer } from '../GameServer.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
const ELIMINATIONS = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
const SERVER = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class StopOwnershipHarness extends TournamentManagerBase {
  constructor(gameServer: GameServer) {
    super('aaaaaaaa-0000-4000-8000-000000000001', gameServer);
  }

  holdSchedulerDrain(promise: Promise<void>): void {
    const jobs = (
      this as unknown as {
        eliminationSchedulerJobs: Set<Promise<void>>;
      }
    ).eliminationSchedulerJobs;
    let tracked!: Promise<void>;
    tracked = promise.finally(() => jobs.delete(tracked));
    jobs.add(tracked);
  }

  addEngine(engine: unknown): void {
    this.tableEngines.set('bbbbbbbb-0000-4000-8000-000000000001', engine as never);
  }

  protected override startEliminationChecker(): void {}

  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

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
    // A rejecting table teardown is diagnostic data for this manager's final
    // ownership certificate.  It must acquire both outcome handlers in the
    // same turn it is started; retaining raw promises until after the
    // scheduler/lifecycle drains lets Node's process-level unhandled-rejection
    // handler restart the entire fleet before allSettled eventually observes
    // the failure.
    expect(stop).toContain('return engine.stop().then<EngineStopOutcome, EngineStopOutcome>(');
    expect(stop).toContain('const initialEngineStops = enginesAtFence.map(beginEngineStop);');
    expect(stop).toContain(
      'const stopResults = await Promise.all(engines.map(([, engine]) => beginEngineStop(engine)))'
    );
    expect(stop).not.toContain(
      'const initialEngineStops = enginesAtFence.map((engine) => engine.stop())'
    );
    expect(stop).toContain("if (result.status === 'rejected')");
    expect(stop).toContain('throw new AggregateError(');
  });

  it('owns an immediately rejected engine stop before a delayed manager drain can yield', async () => {
    const schedulerDrain = deferred();
    const teardownFailure = new Error('authoritative hand commit was not proved');
    const unregisterTournamentTableEngine = vi.fn(() => true);
    const manager = new StopOwnershipHarness({ unregisterTournamentTableEngine } as never);
    const engine = {
      stop: vi.fn(() => Promise.reject(teardownFailure)),
      hasReleasedProcessOwnership: vi.fn(() => false),
    };
    manager.addEngine(engine);
    manager.holdSchedulerDrain(schedulerDrain.promise);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.prependListener('unhandledRejection', onUnhandled);
    try {
      const stopping = manager.stop();

      // Node decides whether a rejection is unhandled at the turn boundary.
      // Keep the manager deliberately inside its earlier scheduler drain for
      // that whole turn: the engine's rejection must already have an owner.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);

      schedulerDrain.resolve();
      await expect(stopping).rejects.toThrow('failed to stop 1 table engine(s)');
      expect(unhandled).toEqual([]);
      expect(engine.stop).toHaveBeenCalledTimes(2);
      expect(unregisterTournamentTableEngine).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      schedulerDrain.resolve();
    }
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
