import { describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { QuarantinedTournamentManagers } from './quarantinedTournamentManagers.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

/*
 * A QUARANTINED STOP IS RETRIED ON ITS OWN SCHEDULE (2026-09-26).
 *
 * On engine 209d1b45 four discovery sweeps re-ran every quarantined stop on
 * every ~5s pass, ignoring the quarantine's 10s-to-60s backoff: 436 managers x
 * one attempt every ~4.4s. The futile fenced requests saturated the event loop
 * (p50 225ms), leases renewed late and were lost, and more managers were
 * quarantined - the fleet collapsed within an hour of each restart.
 */

const QUARANTINE_RETRY = 'GameServer.quarantined_tournament_manager_stop_retry';
const SWEEPS = [
  'GameServer.tournament_completed_cleanup_failed',
  'GameServer.seat_first_stalled_manager_stop_failed',
  'GameServer.completing_manager_stop_failed',
  'GameServer.never_dealt_stop_engine',
];

function harness() {
  const server = Object.create(GameServer.prototype) as any;
  Object.assign(server, {
    tournamentEngines: new Map(),
    tournamentManagerRetirementOperations: new WeakMap(),
    tournamentManagerLeaseReleaseOperations: new Map(),
    tournamentManagerPendingLeaseReleases: new Map(),
    discoveryJobs: new Set(),
    tournamentManagerQuarantine: new QuarantinedTournamentManagers(),
  });
  const manager = () => ({
    stop: vi.fn().mockResolvedValue(undefined),
    getTournamentLeaseGeneration: () => null,
  });
  return { server, manager };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('a quarantined stop is retried only when its quarantine says so', () => {
  it('no discovery sweep re-runs a stop the quarantine holds, however many passes', async () => {
    const { server, manager } = harness();
    const stuck = manager();
    server.tournamentEngines.set('t', stuck);
    server.tournamentManagerQuarantine.record(
      't',
      'GameServer.tournament_lease_lost_stop_failed',
      Date.now(),
      stuck
    );
    for (let pass = 0; pass < 100; pass++) {
      for (const sweep of SWEEPS) server.retireTournamentManagerInDiscovery('t', stuck, sweep);
    }
    await settle();
    expect(stuck.stop).not.toHaveBeenCalled();
    expect(server.discoveryJobs.size).toBe(0);
    expect(server.tournamentEngines.get('t')).toBe(stuck);
  });

  it("the quarantine's own due retry still reaches the stop", async () => {
    const { server, manager } = harness();
    const stuck = manager();
    server.tournamentEngines.set('t', stuck);
    server.tournamentManagerQuarantine.record(
      't',
      'GameServer.tournament_lease_lost_stop_failed',
      Date.now(),
      stuck
    );
    server.retireTournamentManagerInDiscovery('t', stuck, QUARANTINE_RETRY);
    await settle();
    await Promise.all([...server.discoveryJobs]);
    expect(stuck.stop).toHaveBeenCalledOnce();
    expect(server.tournamentEngines.has('t')).toBe(false);
  });

  it('a manager the quarantine does not hold is retired exactly as before', async () => {
    const { server, manager } = harness();
    const done = manager();
    server.tournamentEngines.set('t', done);
    server.retireTournamentManagerInDiscovery('t', done, SWEEPS[0]);
    await settle();
    await Promise.all([...server.discoveryJobs]);
    expect(done.stop).toHaveBeenCalledOnce();
    expect(server.tournamentEngines.has('t')).toBe(false);
  });

  it('a different manager for a quarantined tournament is not held back by a stranger', async () => {
    const { server, manager } = harness();
    const corpse = manager();
    const successor = manager();
    server.tournamentManagerQuarantine.record(
      't',
      'GameServer.tournament_lease_lost_stop_failed',
      Date.now(),
      corpse
    );
    server.tournamentEngines.set('t', successor);
    server.retireTournamentManagerInDiscovery('t', successor, SWEEPS[0]);
    await settle();
    await Promise.all([...server.discoveryJobs]);
    expect(successor.stop).toHaveBeenCalledOnce();
  });
});
