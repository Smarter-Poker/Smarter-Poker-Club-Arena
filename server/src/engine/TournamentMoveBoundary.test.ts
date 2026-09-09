import { describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE_ID = '11111111-1111-4111-8111-111111111111';

function harness(): { engine: ServerTableEngine; state: any } {
  const engine = new ServerTableEngine(TABLE_ID);
  const state = engine as any;
  state.running = true;
  state.handController = null;
  state.postHandTasksPromise = null;
  state.settlementInFlight = new Set();
  state.terminalBoundaryPendingGenerations = new Set();
  state.terminalBoundaryPersistenceFailed = false;
  state.handForHandResolve = null;
  state.tableFSM = {
    state: 'running',
    transition: vi.fn((next: string) => {
      state.tableFSM.state = next;
    }),
  };
  return { engine, state };
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('tournament source-seat move boundary', () => {
  it('does not call a merely idle engine parked until its loop owns the physical gate', async () => {
    const { engine, state } = harness();
    let result: boolean | undefined;
    const parked = engine.parkForTournamentMove('manager-generation', 1_000).then((value) => {
      result = value;
      return value;
    });

    await microtasks();
    expect(engine.isBetweenHands()).toBe(true);
    expect(result).toBeUndefined();

    const gate = state.awaitPauseGate();
    await expect(parked).resolves.toBe(true);
    expect(state.claimedTournamentMovePauseOwners.has('manager-generation')).toBe(true);

    engine.releaseTournamentMovePause('manager-generation');
    await gate;
  });

  it('waits for the accepted hand settlement and post-hand barrier before claiming', async () => {
    const { engine, state } = harness();
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    state.postHandTasksPromise = settlement;
    state.trackSettlementInFlight(settlement);

    let result: boolean | undefined;
    const parked = engine.parkForTournamentMove('manager-generation', 1_000).then((value) => {
      result = value;
      return value;
    });
    const gate = state.awaitPauseGate();
    await microtasks();
    expect(result).toBeUndefined();

    settle();
    await expect(parked).resolves.toBe(true);
    expect(state.postHandTasksPromise).toBeNull();

    engine.releaseTournamentMovePause('manager-generation');
    await gate;
  });

  it('keeps independent pause owners intact across a move release', async () => {
    const { engine, state } = harness();
    state.maintenancePaused = true;
    const parked = engine.parkForTournamentMove('manager-generation', 1_000);
    const gate = state.awaitPauseGate();
    await expect(parked).resolves.toBe(true);

    engine.releaseTournamentMovePause('manager-generation');
    expect(state.maintenancePaused).toBe(true);
    expect(state.handForHandResolve).not.toBeNull();

    engine.resumeFromMaintenance();
    await gate;
  });

  it('holds one source across every awaited move operation until its exact owner releases', async () => {
    const { engine, state } = harness();
    const parked = engine.parkForTournamentMove('manager-generation', 1_000);
    const gate = state.awaitPauseGate();
    await expect(parked).resolves.toBe(true);

    let finish!: () => void;
    const operation = new Promise<string>((resolve) => {
      finish = () => resolve('receipt');
    });
    const result = engine.executeTournamentMoveAtBoundary('manager-generation', () => operation);
    expect(state.tournamentMoveOperations.size).toBe(1);

    engine.resumeDealing();
    expect(state.handForHandResolve).not.toBeNull();
    finish();
    await expect(result).resolves.toBe('receipt');
    expect(state.tournamentMoveOperations.size).toBe(0);
    expect(state.handForHandResolve).not.toBeNull();

    engine.releaseTournamentMovePause('manager-generation');
    await gate;
  });

  it('rejects overlapping work for one owner and ignores release while its operation is live', async () => {
    const { engine, state } = harness();
    const parked = engine.parkForTournamentMove('manager-generation', 1_000);
    const gate = state.awaitPauseGate();
    await expect(parked).resolves.toBe(true);

    let finish!: () => void;
    const operation = new Promise<string>((resolve) => {
      finish = () => resolve('receipt');
    });
    const first = engine.executeTournamentMoveAtBoundary('manager-generation', () => operation);
    await expect(
      engine.executeTournamentMoveAtBoundary('manager-generation', async () => 'impossible')
    ).rejects.toThrow('already has an operation in flight');

    engine.releaseTournamentMovePause('manager-generation');
    expect(state.tournamentMovePauseOwners.has('manager-generation')).toBe(true);
    expect(state.handForHandResolve).not.toBeNull();

    finish();
    await expect(first).resolves.toBe('receipt');
    expect(state.tournamentMoveOperations.size).toBe(0);
    expect(state.tournamentMovePauseOwners.has('manager-generation')).toBe(true);

    engine.releaseTournamentMovePause('manager-generation');
    await gate;
  });

  it('preserves a claimed owner through a watchdog kill for stopped-generation replay', async () => {
    const { engine, state } = harness();
    const parked = engine.parkForTournamentMove('manager-generation', 1_000);
    void state.awaitPauseGate();
    await expect(parked).resolves.toBe(true);

    state.killForRestart('test_watchdog', false);
    expect(state.claimedTournamentMovePauseOwners.has('manager-generation')).toBe(true);
    await expect(engine.parkForTournamentMove('manager-generation', 0)).resolves.toBe(true);
    await expect(
      engine.executeTournamentMoveAtBoundary('manager-generation', async () => 'replayed receipt')
    ).resolves.toBe('replayed receipt');

    engine.releaseTournamentMovePause('manager-generation');
    expect(engine.hasClaimedTournamentMoveBoundary()).toBe(false);
  });
});
