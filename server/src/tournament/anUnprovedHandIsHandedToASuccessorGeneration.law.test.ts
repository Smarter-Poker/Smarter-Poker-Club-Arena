/**
 * LAW: AN UNPROVED HAND IS HANDED TO A SUCCESSOR GENERATION (2026-10-06).
 *
 * Production, 2026-10-06 06:10-07:55 UTC: a database stall exhausted the
 * settlement replay on 78 tables of two events ("authoritative hand commit
 * was not proved"). Every hand was retained and replayable. The manager's
 * recovery stopped each engine, was refused replacement because the stopped
 * engine still held its `attempted` permit, and rescheduled itself - 1,878
 * times in three minutes when it was measured - because the only door that
 * settles a retained hand refuses the generation that retained it. Nothing
 * moved until the process was replaced.
 *
 * The manager now hands the event to a successor generation itself, once
 * every other table has finished the hand in front of its players.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { GameServer } from '../GameServer.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import {
  everyOtherTableIsAtAHandBoundary,
  unprovedHandNeedsSuccessorGeneration,
} from './unprovedHandSuccessor.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));

const EVENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const LEASE = 'bbbbbbbb-0000-4000-8000-000000000001';

class Harness extends TournamentManagerBase {
  protected override async resolveTournamentSeatMoveQuarantine(): Promise<boolean> {
    return false;
  }
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

function deadOriginal(phase: string, generation = LEASE) {
  return {
    stop: vi.fn().mockRejectedValue(new Error('authoritative hand commit was not proved')),
    hasReleasedProcessOwnership: () => true,
    isRunning: () => false,
    isBetweenHands: () => true,
    getF06RetainedPermit: () => ({ phase, binding: { lease_generation: generation } }),
  } as unknown as ServerTableEngine;
}

function liveTable(betweenHands: { value: boolean }) {
  return {
    isRunning: () => true,
    isBetweenHands: () => betweenHands.value,
    pauseAfterHand: vi.fn(),
  } as unknown as ServerTableEngine & { pauseAfterHand: ReturnType<typeof vi.fn> };
}

function world() {
  const handTournamentToSuccessorGeneration = vi.fn();
  const manager = new Harness(
    EVENT,
    { handTournamentToSuccessorGeneration } as unknown as GameServer,
    LEASE,
    performance.now() + 60_000
  ) as any;
  manager.running = true;
  manager.lifecycleIsCurrent = () => true;
  manager.requestEliminationSweep = vi.fn(() => true);
  manager.scheduleManagedTableEngineRecovery = vi.fn();
  return { manager, handTournamentToSuccessorGeneration };
}

afterEach(() => vi.restoreAllMocks());

describe('an unproved hand is handed to a successor generation', () => {
  it('hands the event over when no other table has cards in the air', async () => {
    const { manager, handTournamentToSuccessorGeneration } = world();
    const dead = deadOriginal('attempted');
    manager.tableEngines.set('dead', dead);
    await manager.performManagedTableEngineRecovery('dead', dead, {}, 'unreachable', false);
    expect(handTournamentToSuccessorGeneration).toHaveBeenCalledWith(EVENT, manager);
    expect(manager.scheduleManagedTableEngineRecovery).not.toHaveBeenCalled();
  });

  it('lets a table with cards in the air finish its hand first, and deal no other', async () => {
    const { manager, handTournamentToSuccessorGeneration } = world();
    const dead = deadOriginal('attempted');
    const between = { value: false };
    const live = liveTable(between);
    manager.tableEngines.set('dead', dead);
    manager.tableEngines.set('live', live);

    await manager.performManagedTableEngineRecovery('dead', dead, {}, 'unreachable', false);
    expect(live.pauseAfterHand).toHaveBeenCalledWith(undefined, { untilResumed: true });
    expect(handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
    expect(manager.scheduleManagedTableEngineRecovery).toHaveBeenCalledTimes(1);

    between.value = true;
    await manager.performManagedTableEngineRecovery('dead', dead, {}, 'unreachable', false);
    expect(handTournamentToSuccessorGeneration).toHaveBeenCalledTimes(1);
    expect(manager.scheduleManagedTableEngineRecovery).toHaveBeenCalledTimes(1);
  });

  it('keeps the ordinary causal retry for every permit this generation can still resolve', async () => {
    for (const phase of ['unknown', 'reserved', 'terminated']) {
      const { manager, handTournamentToSuccessorGeneration } = world();
      const dead = deadOriginal(phase);
      manager.tableEngines.set('dead', dead);
      await manager.performManagedTableEngineRecovery('dead', dead, {}, 'unreachable', false);
      expect(handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
      expect(manager.scheduleManagedTableEngineRecovery).toHaveBeenCalledTimes(1);
    }
  });

  it('judges the permit by phase, generation and released ownership', () => {
    const permit = { phase: 'attempted', binding: { lease_generation: LEASE } };
    const yes = {
      permit,
      managerLeaseGeneration: LEASE,
      engineReleasedProcessOwnership: true,
    };
    expect(unprovedHandNeedsSuccessorGeneration(yes)).toBe(true);
    expect(unprovedHandNeedsSuccessorGeneration({ ...yes, permit: null })).toBe(false);
    expect(
      unprovedHandNeedsSuccessorGeneration({ ...yes, engineReleasedProcessOwnership: false })
    ).toBe(false);
    expect(
      unprovedHandNeedsSuccessorGeneration({ ...yes, managerLeaseGeneration: 'another' })
    ).toBe(false);
    const stopped = { isRunning: () => false, isBetweenHands: () => false };
    const dealing = { isRunning: () => true, isBetweenHands: () => false };
    expect(everyOtherTableIsAtAHandBoundary([stopped, dealing], dealing)).toBe(true);
    expect(everyOtherTableIsAtAHandBoundary([stopped, dealing], stopped)).toBe(false);
  });

  it('the owner stops the exact manager and releases its lease, never a bare stop', () => {
    const src = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    const at = src.indexOf('handTournamentToSuccessorGeneration(tournamentId: string');
    const body = src.slice(at, src.indexOf('\n  }\n', at));
    expect(at).toBeGreaterThan(-1);
    expect(body).toContain('exact !== manager');
    expect(body).toContain('this.stopTournamentManagerIfOwned(');
    expect(body).toContain('this.tournamentManagerQuarantine?.heldBy(tournamentId) === exact');
  });
});
