/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A FINISHED TOURNAMENT IS NOT A LOST LEASE (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT
 * #4212 made the ownership renewal pass tell the RUNNING re-adoption budget
 * about every manager it retires (`tournamentResumeDistress +=
 * lostManagers.length`), because a lapsed lease is the re-adoption storm's
 * signature. But a tournament that finishes stops its own manager and leaves
 * it in tournamentEngines for that pass to retire, and renewal refuses a
 * stopped manager. So every normal completion was reported as "Lost the
 * tournament lease ... to another engine instance" and charged as distress.
 * Production's retained logs have that line 4-7 s after each of three
 * completions; at 400-700 completions an hour, half the lane's passes or more
 * were distressed and the budget sat between a half and a fifth of its design
 * with no lease trouble at all. The charge was also per pass, not per manager:
 * a quarantined manager whose stop() keeps failing stays in the map and would
 * be charged every five seconds, holding the budget at its floor for the life
 * of the process.
 *
 * THE LAW
 * Only a lost lease is distress, and a manager is charged at most once. A
 * manager that stood down on its own with its lease intact (finished, failed
 * to resume, stopped) is still fenced and retired, without a report or a
 * charge. An expired proof, a database fence or a takeover while running is
 * still reported and charged.
 *
 * The managers below are real TournamentManagerBase generations, driven into
 * each state the way production gets there and fed through the real renewal
 * pass. Against the old pass the first count reads 5, not 3. With the
 * stand-down check kept but the judged-once set removed, the second pass
 * charges 6, not 1: the first pass's fence sets the expiry flag, so even the
 * finished managers look lost the second time. Both checked by reverting the
 * fix and re-running.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('./services/errorReporter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/errorReporter.js')>()),
  reportError: reportErrorMock,
}));

import { GameServer } from './GameServer.js';
import { BoundedLeaseRenewalScope } from './services/BoundedLeaseRenewalScope.js';
import { _setTournamentLeaseMonotonicNowForTests } from './services/tournamentLease.js';
import type { TournamentLifecycleToken } from './tournament/TournamentLifecycleEpoch.js';
import { TournamentManagerBase } from './tournament/TournamentManagerBase.js';

let generations = 0;

/** One manager generation, as GameServer admission publishes it. */
class Generation extends TournamentManagerBase {
  constructor(tournamentId: string, proofDeadline: number) {
    generations++;
    super(
      tournamentId,
      {} as GameServer,
      `bbbbbbbb-0000-4000-8000-${String(generations).padStart(12, '0')}`,
      proofDeadline
    );
  }

  /** What start()/resume() do before their first await. */
  activate(): this {
    (
      this as unknown as { lifecycleEpoch: { begin(): TournamentLifecycleToken } }
    ).lifecycleEpoch.begin();
    this.running = true;
    (this as unknown as { armTournamentLeaseExpiryTimer(): void }).armTournamentLeaseExpiryTimer();
    return this;
  }

  /** resumeLifecycle's catch: reports resume_failed, sets running = false, returns. */
  failResume(): this {
    this.running = false;
    return this;
  }

  rawRunning(): boolean {
    return this.running;
  }

  protected override startEliminationChecker(): void {}

  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

/**
 * The real performOwnedEngineLeaseProofRenewal on a bare server. The two
 * heartbeat halves are replaced by what they returned: `lost()` is the map the
 * tournament half hands back. Retirement is recorded and never completes, so
 * every manager stays in tournamentEngines - the quarantine shape.
 */
function bareServer(engines: Map<string, Generation>, lost: () => Map<string, Generation>) {
  const server = Object.create(GameServer.prototype) as any;
  server.running = true;
  server.lifecycleGeneration = 1;
  server.shutdownOwnershipLeaseRenewalActive = false;
  server.cashLeaseRenewalScope = new BoundedLeaseRenewalScope();
  server.tournamentLeaseRenewalScope = new BoundedLeaseRenewalScope();
  server.tableEngines = new Map();
  server.tournamentOwnedTables = new Set();
  server.tournamentEngines = engines;
  server.tournamentResumeDistress = 0;
  server.tournamentManagersJudgedLost = new WeakSet();
  server.serverLifecycleJobs = new Set();
  server.renewVerifiedCashTableLeaseProofs = async () => new Map();
  server.renewVerifiedTournamentManagerLeaseProofs = async () => lost();
  server.stopTournamentManagerIfOwned = vi.fn(async () => false);
  return server as {
    performOwnedEngineLeaseProofRenewal(abandoned: () => void): Promise<boolean>;
    tournamentResumeDistress: number;
    stopTournamentManagerIfOwned: ReturnType<typeof vi.fn>;
  };
}

const leaseLostReports = (): string[] =>
  reportErrorMock.mock.calls
    .filter(([, context]) => context === 'GameServer.tournament_lease_lost')
    .map(([error]) => {
      const match =
        /^Tournament (\S+) (?:no longer proves its current lease generation|could not prove its lease generation inside its window)/.exec(
          String((error as Error).message)
        );
      expect(match).not.toBeNull();
      return match![1];
    });

const live: Generation[] = [];
const generation = (tournamentId: string, proofDeadline = 20_000): Generation => {
  const manager = new Generation(tournamentId, proofDeadline).activate();
  live.push(manager);
  return manager;
};

afterEach(async () => {
  await Promise.allSettled(live.splice(0).map((manager) => manager.stop()));
  _setTournamentLeaseMonotonicNowForTests();
  reportErrorMock.mockReset();
});

describe('only a lost lease is re-adoption distress', () => {
  it('a finished or failed-to-resume manager is retired quietly; a lost lease is charged, once', async () => {
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);

    // Stood down on their own, lease intact.
    const finished = generation('t-finished');
    void finished.stop(); // TournamentManagerEliminations: `void this.stop()` after COMPLETE
    const resumeFailed = generation('t-resume-failed').failResume();
    // Lost their lease, three different ways.
    const expired = generation('t-expired', 10_000);
    now = 10_000;
    // renewVerifiedTournamentManagerLeaseProofs reads this first; expiry fences.
    expect(expired.hasCurrentTournamentLeaseAuthority()).toBe(false);
    const fenced = generation('t-db-fenced');
    fenced.standDownForDatabaseFence();
    const takenOver = generation('t-taken-over'); // still running; the heartbeat says lost

    const engines = new Map<string, Generation>(
      [finished, resumeFailed, expired, fenced, takenOver].map((m) => [
        (m as unknown as { tournamentId: string }).tournamentId,
        m,
      ])
    );
    const server = bareServer(engines, () => new Map(engines));
    reportErrorMock.mockClear();

    await server.performOwnedEngineLeaseProofRenewal(() => {});

    expect(server.tournamentResumeDistress).toBe(3);
    expect(leaseLostReports()).toEqual(['t-expired', 't-db-fenced', 't-taken-over']);
    // Every one of them is still fenced and handed to retirement.
    expect(server.stopTournamentManagerIfOwned).toHaveBeenCalledTimes(5);
    expect(takenOver.rawRunning()).toBe(false);
    expect(takenOver.stoodDownWithItsLeaseIntact()).toBe(false);

    // Retirement did not complete (a stop() that keeps failing keeps the
    // manager quarantined in the map), so the next pass finds all five again,
    // plus one generation that has just lost its lease for the first time.
    const lateLoss = generation('t-late-loss');
    engines.set('t-late-loss', lateLoss);
    server.tournamentResumeDistress = 0; // the lane read and cleared it

    await server.performOwnedEngineLeaseProofRenewal(() => {});

    expect(server.tournamentResumeDistress).toBe(1);
    expect(leaseLostReports()).toEqual(['t-expired', 't-db-fenced', 't-taken-over', 't-late-loss']);
    expect(server.stopTournamentManagerIfOwned).toHaveBeenCalledTimes(11);

    // And once more, with nothing new: nothing is charged at all.
    server.tournamentResumeDistress = 0;
    await server.performOwnedEngineLeaseProofRenewal(() => {});
    expect(server.tournamentResumeDistress).toBe(0);
    expect(leaseLostReports()).toHaveLength(4);
  });

  it('the judgment is read-only, so a lapsed proof cannot turn a stand-down into a loss', () => {
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);
    const finished = generation('t-finished');
    void finished.stop();
    now = 30_000; // its proof has lapsed since; nothing has read it yet
    reportErrorMock.mockClear();

    expect(finished.stoodDownWithItsLeaseIntact()).toBe(true);
    expect(finished.stoodDownWithItsLeaseIntact()).toBe(true);
    expect(reportErrorMock).not.toHaveBeenCalled();

    // Which is why the renewal pass must not ask isRunning() or
    // hasCurrentTournamentLeaseAuthority() here: both expire the proof as they
    // read it, and expiry is a fence.
    expect(finished.isRunning()).toBe(false);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('expired before it was renewed'),
      }),
      'Tournament.lease_proof_expired'
    );
    expect(finished.stoodDownWithItsLeaseIntact()).toBe(false);
  });

  it('a manager draining hands for shutdown still depends on its lease', () => {
    _setTournamentLeaseMonotonicNowForTests(() => 0);
    const draining = generation('t-draining');
    draining.beginServerShutdownDrain();
    expect(draining.rawRunning()).toBe(false);
    expect(draining.stoodDownWithItsLeaseIntact()).toBe(false);
    draining.fenceForServerShutdown();
    expect(draining.stoodDownWithItsLeaseIntact()).toBe(true);
  });
});
