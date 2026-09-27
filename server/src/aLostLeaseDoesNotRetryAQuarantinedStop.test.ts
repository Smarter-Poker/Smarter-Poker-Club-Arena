/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LOST LEASE DOES NOT RETRY A QUARANTINED STOP (2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT
 * #5317 made the discovery sweeps defer to the quarantine's backoff (10 s,
 * doubling, capped at 60 s). The ownership lease renewal pass was left out.
 * It runs every 5 s and adds every manager in tournamentEngines that no longer
 * proves lease authority to its lost set, then launches the stop again. A
 * quarantined manager is exactly such a manager: it never proves authority
 * again, and its failed stop leaves it in the map. So every pass re-ran the
 * stop, and each failure re-recorded the quarantine, pushing its own due time
 * forward so the quarantine's schedule never fired at all.
 *
 * Production /health on 2026-09-27 (engine f2e484a3): six quarantined
 * managers, each with ~16,000 attempts in ~84,000 s, one every ~5.2 s, every
 * one logged as GameServer.tournament_lease_lost_stop_failed.
 *
 * A quarantine retry also charged the attempt twice (once before the retry,
 * once when the retried stop failed), which skipped the 20 s step.
 *
 * THE LAW
 * The first lost-lease stop runs at once. Once it has failed, the quarantine
 * alone decides when the stop runs again: 10 s, 20 s, 40 s, then every 60 s,
 * and /health's attempts count equals the stops actually run.
 *
 * The real renewal pass, retirement path and quarantine pass run below on a
 * bare server, driven on the production 5 s cadence for five minutes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./services/errorReporter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/errorReporter.js')>()),
  reportError: vi.fn(),
}));

import { GameServer } from './GameServer.js';
import { BoundedLeaseRenewalScope } from './services/BoundedLeaseRenewalScope.js';
import { QuarantinedTournamentManagers } from './tournament/quarantinedTournamentManagers.js';

const PASS_MS = 5_000;

let now = 0;

function corpse(stops: number[]) {
  return {
    stop: vi.fn(async (): Promise<void> => {
      stops.push(now);
      throw new Error('Tournament t failed to stop 1 table engine(s)');
    }),
    getTournamentLeaseGeneration: () => null,
    hasCurrentTournamentLeaseAuthority: () => false,
    stoodDownWithItsLeaseIntact: () => false,
    fenceForTournamentLeaseLoss: vi.fn(),
    isF06RecoveryOwner: () => false,
  };
}

function bareServer() {
  const server = Object.create(GameServer.prototype) as any;
  Object.assign(server, {
    running: true,
    lifecycleGeneration: 1,
    shutdownOwnershipLeaseRenewalActive: false,
    cashLeaseRenewalScope: new BoundedLeaseRenewalScope(),
    tournamentLeaseRenewalScope: new BoundedLeaseRenewalScope(),
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
    tournamentEngines: new Map(),
    tournamentResumeDistress: 0,
    tournamentManagersJudgedLost: new WeakSet(),
    tournamentManagerRetirementOperations: new WeakMap(),
    tournamentManagerLeaseReleaseOperations: new Map(),
    tournamentManagerPendingLeaseReleases: new Map(),
    serverLifecycleJobs: new Set(),
    discoveryJobs: new Set(),
    tournamentManagerQuarantine: new QuarantinedTournamentManagers(),
  });
  server.renewVerifiedCashTableLeaseProofs = async () => new Map();
  server.renewVerifiedTournamentManagerLeaseProofs = async () => new Map();
  // The drained-custody fallback is refused, as #5409's refusal does today.
  server.transferDrainedF06Custody = async () => false;
  return server;
}

/** One production pass: lease renewal, then the discovery sweep's quarantine pass. */
async function pass(server: any): Promise<void> {
  await server.performOwnedEngineLeaseProofRenewal(() => {});
  while (server.serverLifecycleJobs.size > 0)
    await Promise.allSettled([...server.serverLifecycleJobs]);
  server.settleQuarantinedTournamentManagers([{ id: 't' }], 1);
  while (server.discoveryJobs.size > 0) await Promise.allSettled([...server.discoveryJobs]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a lost lease does not retry a quarantined stop', () => {
  it('after the first failure the stop runs on the quarantine schedule, not every pass', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const server = bareServer();
    const stops: number[] = [];
    const manager = corpse(stops);
    server.tournamentEngines.set('t', manager);

    for (now = 0; now <= 300_000; now += PASS_MS) await pass(server);

    // Before the fix: 61 stops, one per 5 s pass.
    expect(stops).toEqual([0, 10_000, 30_000, 70_000, 130_000, 190_000, 250_000]);
    const [row] = server.tournamentManagerQuarantine.snapshot(now);
    expect(row.attempts).toBe(stops.length);
    expect(row.dueAtMs).toBe(310_000);
    // It is still fenced on every pass; only the futile stop is withheld.
    expect(manager.fenceForTournamentLeaseLoss.mock.calls.length).toBe(61);
    expect(server.tournamentEngines.get('t')).toBe(manager);
  });

  it('a manager that loses its lease for the first time is stopped at once', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    now = 0;
    const server = bareServer();
    const stops: number[] = [];
    const lost = corpse(stops);
    lost.stop.mockImplementation(async () => {
      stops.push(now);
    });
    server.tournamentEngines.set('t', lost);
    await pass(server);
    expect(stops).toEqual([0]);
    expect(server.tournamentEngines.has('t')).toBe(false);
    expect(server.tournamentManagerQuarantine.size).toBe(0);
  });

  it('a successor that loses its lease is not held back by its predecessor quarantine', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    now = 0;
    const server = bareServer();
    const stops: number[] = [];
    const predecessor = corpse([]);
    server.tournamentManagerQuarantine.record(
      't',
      'GameServer.tournament_lease_lost_stop_failed',
      0,
      predecessor
    );
    const successor = corpse(stops);
    server.tournamentEngines.set('t', successor);
    await server.performOwnedEngineLeaseProofRenewal(() => {});
    while (server.serverLifecycleJobs.size > 0)
      await Promise.allSettled([...server.serverLifecycleJobs]);
    expect(stops).toEqual([0]);
    expect(server.tournamentManagerQuarantine.heldBy('t')).toBe(successor);
  });
});
