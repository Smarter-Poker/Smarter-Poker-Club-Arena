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
    const fence = sliceMethod(BASE, 'private applyStopFence()');
    const stop = sliceMethod(BASE, 'stop(): Promise<void>');
    const abortAt = fence.indexOf('this.lifecycleEpoch.abort();');
    const applyFenceAt = stop.indexOf('this.applyStopFence();');
    const schedulerDrainAt = stop.indexOf('await this.drainEliminationSchedulerJobs();');
    const jobDrainAt = stop.indexOf('await this.drainLifecycleJobs();');
    const engineStopAt = stop.indexOf('engine.stop()');
    const unregisterAt = stop.indexOf('this.gameServer.unregisterTournamentTableEngine(');

    expect(abortAt).toBeGreaterThan(0);
    expect(fence).not.toContain('await ');
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
      'addon_period_triggered: true',
    ]) {
      const mutationAt = BASE.indexOf(mutation);
      expect(mutationAt).toBeGreaterThan(0);
      expect(BASE.slice(Math.max(0, mutationAt - 500), mutationAt)).toContain(
        'void this.trackLifecycleJob('
      );
    }
  });

  it('never performs an unowned manager-map delete or overwrites after an awaited lease claim', () => {
    expect(SERVER).not.toContain('this.tournamentEngines.delete(');
    expect(SERVER).toContain('return stopOwnedTournamentManager(');
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
    expect(ELIMINATIONS).not.toContain('await this.stop();');
    expect(ELIMINATIONS.match(/void this\.stop\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('lets the server fence manager mutations before its graceful dealer drain', () => {
    const publicFence = sliceMethod(BASE, 'fenceForServerShutdown(): void');
    expect(publicFence).toContain('this.applyStopFence();');
    expect(publicFence).not.toContain('engine.stop()');
  });
});
