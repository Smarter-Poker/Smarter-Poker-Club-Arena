import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GameServer } from '../GameServer.js';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

describe('discovery isolates the physical retirement of each tournament', () => {
  it('keeps a hung manager owned without holding up another event or multiplying jobs', async () => {
    const server = Object.create(GameServer.prototype) as any;
    Object.assign(server, {
      tournamentEngines: new Map(),
      tournamentManagerRetirementOperations: new WeakMap(),
      tournamentManagerLeaseReleaseOperations: new Map(),
      tournamentManagerPendingLeaseReleases: new Map(),
      discoveryJobs: new Set(),
    });
    let finishSlowStop!: () => void;
    const slow = {
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSlowStop = resolve;
          })
      ),
      getTournamentLeaseGeneration: () => null,
    };
    const next = {
      stop: vi.fn().mockResolvedValue(undefined),
      getTournamentLeaseGeneration: () => null,
    };
    server.tournamentEngines.set('slow', slow);
    server.tournamentEngines.set('next', next);
    expect(server.retireTournamentManagerInDiscovery('slow', slow, 'test.stop')).toBeUndefined();
    for (let pass = 0; pass < 100; pass++) {
      server.retireTournamentManagerInDiscovery('slow', slow, 'test.stop');
    }
    expect(slow.stop).toHaveBeenCalledOnce();
    expect(server.discoveryJobs.size).toBe(1);
    expect(server.tournamentEngines.get('slow')).toBe(slow);
    server.retireTournamentManagerInDiscovery('next', next, 'test.stop');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(next.stop).toHaveBeenCalledOnce();
    expect(server.tournamentEngines.has('next')).toBe(false);
    expect(server.tournamentEngines.get('slow')).toBe(slow);
    expect(server.discoveryJobs.size).toBe(1);
    finishSlowStop();
    await Promise.all([...server.discoveryJobs]);
    expect(server.tournamentEngines.size).toBe(0);
    expect(server.discoveryJobs.size).toBe(0);
  });

  it('routes every retirement in the registering discovery loop through isolation', () => {
    const source = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    const discovery = sliceMethod(source, 'private async discoverTournaments(');
    expect(discovery).not.toContain('await this.stopTournamentManagerIfOwned(');
    for (const context of [
      'GameServer.seat_first_stalled_manager_stop_failed',
      'GameServer.tournament_completed_cleanup_failed',
      'GameServer.completing_manager_stop_failed',
      'GameServer.never_dealt_stop_engine',
    ]) {
      expect(discovery).toContain(context);
    }
  });
});
