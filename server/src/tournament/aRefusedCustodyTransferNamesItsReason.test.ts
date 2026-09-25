/**
 * A REFUSED CUSTODY TRANSFER NAMES ITS REASON, ONCE, AND /health SHOWS IT
 * (2026-09-25).
 *
 * On production release 778075b4, seventeen managers that had lost their
 * lease sat quarantined for hours. Each was re-offered the same custody
 * transfer every five seconds, thousands of attempts apiece, and the log held
 * not one line saying which of the fifteen guards had refused. /health said
 * `reason: GameServer.tournament_lease_lost_stop_failed` and nothing more.
 *
 * These cases pin the observability half: the refusal the capture named
 * reaches the quarantine record and /health as `custodyRefusal`; it is logged
 * once per manager per distinct reason, not once per attempt; and a reason
 * that changes is logged again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { F06CustodyRefusal } from './drainedF06Custody.js';
import * as leases from '../services/tournamentLease.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

class Harness extends TournamentManagerBase {
  refusal: F06CustodyRefusal | null = null;
  async captureDrainedF06Custody() {
    return null;
  }
  async captureMixedF06Custody() {
    return null;
  }
  lastF06CustodyRefusal() {
    return this.refusal;
  }
  protected startEliminationChecker() {}
  protected async recalculateEliminatedPrizes() {
    return true;
  }
  protected async resolveTournamentSeatMoveQuarantine() {
    return true;
  }
}
class UnnamedHarness extends TournamentManagerBase {
  async captureDrainedF06Custody() {
    return null;
  }
  async captureMixedF06Custody() {
    return null;
  }
  protected startEliminationChecker() {}
  protected async recalculateEliminatedPrizes() {
    return true;
  }
  protected async resolveTournamentSeatMoveQuarantine() {
    return true;
  }
}
function stuck(manager: any) {
  vi.spyOn(manager, 'stop').mockRejectedValue(new Error('owned stop failure'));
  return manager;
}
function game(manager: any): any {
  const server: any = new GameServer();
  server.tournamentEngines.set(id(1), manager);
  return server;
}
const warnings = () =>
  (console.warn as ReturnType<typeof vi.fn>).mock.calls
    .filter(([prefix]) => prefix === '[tournament-custody-refused]')
    .map(([, serialized]) => JSON.parse(serialized as string));

afterEach(() => vi.restoreAllMocks());

describe('a refused custody transfer names its reason', () => {
  it('carries the named refusal into the quarantine record and onto /health', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const release = vi.spyOn(leases, 'releaseTournaments');
    const manager = stuck(new Harness(id(1), {} as any, id(2), performance.now() + 20_000));
    manager.refusal = { path: 'mixed', refused: 'originals_not_drained', detail: 'engine_running' };
    const server = game(manager);
    await expect(server.stopTournamentManagerIfOwned(id(1), manager, 'test')).resolves.toBe(false);
    expect(server.tournamentEngines.get(id(1))).toBe(manager);
    expect(release).not.toHaveBeenCalled();
    const [row] = server.getStatus().quarantinedTournamentManagers;
    expect(row).toMatchObject({
      tournamentId: id(1),
      reason: 'test',
      custodyRefusal: 'mixed:originals_not_drained:engine_running',
      attempts: 1,
    });
    expect(typeof row.ageMs).toBe('number');
    expect(server.getStatus().tournamentManagersQuarantined).toBe(1);
  });

  it('a capture that returns null without naming why is itself named', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = stuck(new UnnamedHarness(id(1), {} as any, id(2), performance.now() + 20_000));
    const server = game(manager);
    await expect(server.stopTournamentManagerIfOwned(id(1), manager, 'test')).resolves.toBe(false);
    expect(server.getStatus().quarantinedTournamentManagers[0].custodyRefusal).toBe(
      'transfer:capture_refusal_unnamed'
    );
  });

  it('logs a refusal once per manager per distinct reason, and again when the reason changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = stuck(new Harness(id(1), {} as any, id(2), performance.now() + 20_000));
    manager.refusal = { path: 'mixed', refused: 'nothing_to_transfer' };
    const server = game(manager);

    await server.stopTournamentManagerIfOwned(id(1), manager, 'test');
    await server.stopTournamentManagerIfOwned(id(1), manager, 'test');
    expect(warnings()).toEqual([
      {
        tournamentId: id(1),
        path: 'mixed',
        refused: 'nothing_to_transfer',
        detail: null,
        priorAttempts: 0,
      },
    ]);
    expect(server.getStatus().quarantinedTournamentManagers[0]).toMatchObject({
      custodyRefusal: 'mixed:nothing_to_transfer',
      attempts: 2,
    });

    manager.refusal = {
      path: 'mixed',
      refused: 'stale_before_prepare',
      detail: 'originals_changed',
    };
    await server.stopTournamentManagerIfOwned(id(1), manager, 'test');
    await server.stopTournamentManagerIfOwned(id(1), manager, 'test');
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]).toEqual({
      tournamentId: id(1),
      path: 'mixed',
      refused: 'stale_before_prepare',
      detail: 'originals_changed',
      priorAttempts: 2,
    });
    expect(server.getStatus().quarantinedTournamentManagers[0]).toMatchObject({
      custodyRefusal: 'mixed:stale_before_prepare:originals_changed',
      attempts: 4,
    });

    // A different manager stuck on the same tournament starts its own record.
    const successor = stuck(new Harness(id(1), {} as any, id(3), performance.now() + 20_000));
    successor.refusal = { path: 'mixed', refused: 'nothing_to_transfer' };
    server.tournamentEngines.set(id(1), successor);
    await server.stopTournamentManagerIfOwned(id(1), successor, 'test');
    expect(warnings()).toHaveLength(3);
    expect(server.getStatus().quarantinedTournamentManagers[0]).toMatchObject({
      custodyRefusal: 'mixed:nothing_to_transfer',
      attempts: 1,
    });
  });
});
