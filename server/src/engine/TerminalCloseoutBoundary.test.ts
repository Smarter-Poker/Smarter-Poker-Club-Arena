import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';

function boundaryHarness(): any {
  const engine = Object.create(ServerTableEngineBase.prototype) as any;
  engine.running = true;
  engine.tableId = '00000000-0000-4000-8000-000000000001';
  engine.handForHandPaused = false;
  engine.maintenancePaused = false;
  engine.terminalCloseoutPaused = false;
  engine.terminalCloseoutWaiters = new Set();
  engine.handForHandResolve = null;
  engine.handController = null;
  engine.postHandTasksPromise = null;
  engine.settlementInFlight = new Set();
  engine.terminalBoundaryPersistenceGeneration = 0;
  engine.terminalBoundaryPendingGenerations = new Set();
  engine.terminalBoundaryPersistenceFailed = false;
  engine.pausedSinceMs = 0;
  engine.tableFSM = {
    state: 'running',
    transition: vi.fn((state: string) => {
      engine.tableFSM.state = state;
    }),
  };
  return engine;
}

async function oneMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('the terminal tournament boundary owns the next deal', () => {
  it('does not report parked after the gameplay barrier is abandoned while settlement still writes', async () => {
    const engine = boundaryHarness();
    engine.handController = { stage: 'river' };
    const generation = engine.beginTerminalBoundaryPersistence();
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    engine.trackSettlementInFlight(settlement);

    let parkResult: boolean | undefined;
    const parked = engine.parkForTerminalCloseout(1_000).then((result: boolean) => {
      parkResult = result;
      return result;
    });
    const gate = engine.awaitPauseGate();
    await oneMicrotask();
    expect(parkResult).toBeUndefined();

    engine.handController = null;
    await oneMicrotask();
    expect(parkResult).toBeUndefined();

    engine.finishTerminalBoundaryPersistence(generation, true);
    settle();
    await expect(parked).resolves.toBe(true);

    engine.terminalCloseoutPaused = false;
    const release = engine.handForHandResolve;
    engine.handForHandResolve = null;
    release();
    await gate;
  });

  it('refuses a terminal boundary after the final hand stack write fails', async () => {
    const engine = boundaryHarness();
    const generation = engine.beginTerminalBoundaryPersistence();
    let rejectSettlement!: (reason: Error) => void;
    const settlement = new Promise<void>((_resolve, reject) => {
      rejectSettlement = reject;
    });
    engine.trackSettlementInFlight(settlement);

    const parked = engine.parkForTerminalCloseout(1_000);
    const gate = engine.awaitPauseGate();
    engine.finishTerminalBoundaryPersistence(generation, false);
    rejectSettlement(new Error('database refused final stacks'));

    await expect(parked).resolves.toBe(false);
    engine.releaseTerminalCloseoutPause();
    await gate;
  });

  it('waits for every overlapping settlement after a gameplay timeout', async () => {
    const engine = boundaryHarness();
    let finishOlder!: () => void;
    let finishNewest!: () => void;
    const older = new Promise<void>((resolve) => {
      finishOlder = resolve;
    });
    const newest = new Promise<void>((resolve) => {
      finishNewest = resolve;
    });
    engine.trackSettlementInFlight(older);
    engine.trackSettlementInFlight(newest);

    let parkResult: boolean | undefined;
    const parked = engine.parkForTerminalCloseout(1_000).then((result: boolean) => {
      parkResult = result;
      return result;
    });
    const gate = engine.awaitPauseGate();

    finishNewest();
    await oneMicrotask();
    expect(parkResult).toBeUndefined();

    finishOlder();
    await expect(parked).resolves.toBe(true);
    engine.releaseTerminalCloseoutPause();
    await gate;
  });

  it('can prove an already-idle table only after the pause gate owns it', async () => {
    const engine = boundaryHarness();
    let parkResult: boolean | undefined;
    const parked = engine.parkForTerminalCloseout(1_000).then((result: boolean) => {
      parkResult = result;
      return result;
    });
    await oneMicrotask();
    expect(parkResult).toBeUndefined();

    const gate = engine.awaitPauseGate();
    await expect(parked).resolves.toBe(true);

    engine.terminalCloseoutPaused = false;
    const release = engine.handForHandResolve;
    engine.handForHandResolve = null;
    release();
    await gate;
  });

  it('discards an unstarted hand when the terminal pause arrives during preparation', async () => {
    const engine = boundaryHarness();
    const start = vi.fn();
    const endSpan = vi.fn();
    engine.handController = { start };
    engine.currentHandDealtStacks = new Map([['player', 100]]);
    engine.handSpan = { end: endSpan };
    engine.shadowRecorder = {};
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });

    const attemptedStart = (async () => {
      await preparation;
      if (!engine.discardPreparedHandForTerminalCloseout()) start();
    })();
    engine.terminalCloseoutPaused = true;
    finishPreparation();
    await attemptedStart;

    expect(start).not.toHaveBeenCalled();
    expect(engine.handController).toBeNull();
    expect(engine.currentHandDealtStacks.size).toBe(0);
    expect(endSpan).toHaveBeenCalledOnce();
    expect(engine.terminalCloseoutDiscardedPreparedHand).toBe(true);
  });

  it('revalidates stacks and votes after parking and before the terminal RPC', () => {
    const source = readFileSync(
      join(__dirname, '../tournament/TournamentManagerEliminations.ts'),
      'utf8'
    );
    const start = source.indexOf('private async completeFinalTableDealAtBoundary');
    const end = source.indexOf('private async settleFinalTableDeal', start);
    const method = source.slice(start, end);
    const parkedAt = method.indexOf('parkForTerminalCloseout');
    const rosterAt = method.indexOf(".select('user_id, chips')");
    const votesAt = method.indexOf(".from('tournament_deal_votes')");
    const terminalAt = method.indexOf('requestTournamentTerminalReceipt');

    expect(parkedAt).toBeGreaterThan(-1);
    expect(rosterAt).toBeGreaterThan(parkedAt);
    expect(votesAt).toBeGreaterThan(rosterAt);
    expect(terminalAt).toBeGreaterThan(votesAt);
    expect(method).toContain('Number(player.chips) <= 0');
    expect(method).toContain('receipt.dealShares.length === alive.length');
    expect(method).not.toContain('receipt.payouts.length === alive.length');
    expect(method).toContain('throw new TerminalSettlementCommittedError');
  });

  it('never clears the durable in-flight signal when the five-minute gameplay wait stands down', () => {
    const source = readFileSync(join(__dirname, 'ServerTableEngineDealing.ts'), 'utf8');
    const barrier = source.slice(
      source.indexOf('while (this.postHandTasksPromise)'),
      source.indexOf('// THE PARK', source.indexOf('while (this.postHandTasksPromise)'))
    );
    expect(barrier).not.toContain('trackSettlementInFlight(null)');
    expect(barrier).toContain('this.postHandTasksPromise = null');
    const base = readFileSync(join(__dirname, 'ServerTableEngineBase.ts'), 'utf8');
    expect(base).toContain('protected settlementInFlight: Set<Promise<void>> = new Set();');
    expect(base).toContain('this.settlementInFlight.add(p)');
    expect(base).toContain('this.settlementInFlight.delete(tracked)');
  });

  it('rechecks the terminal owner after every awaited pre-deal boundary', () => {
    const source = readFileSync(join(__dirname, 'ServerTableEngineDealing.ts'), 'utf8');
    const announce = source.indexOf("'announce_seat_moves'");
    const announceGate = source.indexOf('if (this.terminalCloseoutPaused)', announce);
    const rest = source.indexOf('await this.awaitNextHandRest();', announceGate);
    const restGate = source.indexOf('if (this.terminalCloseoutPaused)', rest);
    const deal = source.indexOf('await this.dealHand(activePlayers)', announce);
    expect(announceGate).toBeGreaterThan(announce);
    expect(rest).toBeGreaterThan(announceGate);
    expect(restGate).toBeGreaterThan(rest);
    expect(deal).toBeGreaterThan(restGate);

    const method = source.slice(source.indexOf('protected async dealHand('));
    const allocate = method.indexOf('await this.allocateGlobalHandNumber()');
    const allocatedGate = method.indexOf('discardPreparedHandForTerminalCloseout()', allocate);
    const timeBanks = method.indexOf('await this.fetchTimeBankExtras(');
    const timeBankGate = method.indexOf('discardPreparedHandForTerminalCloseout()', timeBanks);
    const generation = method.indexOf('this.beginTerminalBoundaryPersistence()');
    const finalGate = method.lastIndexOf('discardPreparedHandForTerminalCloseout()', generation);
    const start = method.indexOf('this.handController!.start()', generation);
    expect(allocatedGate).toBeGreaterThan(allocate);
    expect(timeBankGate).toBeGreaterThan(timeBanks);
    expect(finalGate).toBeGreaterThan(timeBankGate);
    expect(generation).toBeGreaterThan(finalGate);
    expect(start).toBeGreaterThan(generation);
    expect(method.slice(finalGate, start)).not.toContain('await ');
  });

  it('finishes teardown after a snapshot flush rejects', async () => {
    const engine = Object.create(ServerTableEngineBase.prototype) as any;
    const dispose = vi.fn();
    engine.running = true;
    engine.tableId = '00000000-0000-4000-8000-000000000001';
    engine.handCount = 17;
    engine.handsDealtThisSession = 3;
    engine.terminalCloseoutWaiters = new Set();
    engine.handForHandResolve = null;
    engine.heartbeatActive = true;
    engine.tableFSM = { transition: vi.fn() };
    engine.settleReady = vi.fn();
    engine.clearHandSafetyTimer = vi.fn();
    engine.clearLooseHandTimers = vi.fn();
    engine.unsubscribeManualBomb = vi.fn();
    engine.clearTurnTimer = vi.fn();
    engine.flushSnapshot = vi.fn().mockRejectedValue(new Error('snapshot unavailable'));
    engine.snapshotTimer = null;
    engine.handController = {};
    engine.preciseTimer = { dispose };
    engine.actionValidator = { dispose };
    engine.stateVerifier = { dispose };
    engine.timeBankEngine = { disposeAll: dispose };
    engine.disconnectEngine = { disposeAll: dispose };
    engine.preActionEngine = { disposeAll: dispose };
    engine.atomicStackService = { dispose: dispose };
    engine.straddleEngine = { disposeAll: dispose };
    engine.runItTwiceEngine = { disposeAll: dispose };
    engine.insuranceEngine = { disposeAll: dispose };
    engine.engineTelemetry = { dispose };
    (ServerTableEngineBase as any).liveEngines.set(engine.tableId, engine);

    await expect(engine.stop()).resolves.toBeUndefined();

    expect(engine.running).toBe(false);
    expect(engine.handController).toBeNull();
    expect(engine.tableFSM.transition).toHaveBeenNthCalledWith(1, 'closing');
    expect(engine.tableFSM.transition).toHaveBeenLastCalledWith('closed');
    expect(dispose).toHaveBeenCalledTimes(11);
    expect((ServerTableEngineBase as any).isCurrentEngineFor(engine.tableId, engine)).toBe(false);
  });
});
