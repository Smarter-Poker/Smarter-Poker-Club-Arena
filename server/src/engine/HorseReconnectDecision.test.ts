import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({
  decideFast: vi.fn(),
  decideDeep: vi.fn(),
  commitDecisionEffects: vi.fn(async () => ({})),
  runWithDispatchBarrier: vi.fn(<T>(fn: () => T): T => fn()),
}));
vi.mock('./horseDecision/index.js', async () => ({
  ...(await vi.importActual<typeof import('./horseDecision/index.js')>('./horseDecision/index.js')),
  getLiveHorseDecisionWorker: () => worker,
}));

import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'fafa1200-1234-4321-9876-aaaaaaaaaaaa';
const PLAYER = 'reconnecting-horse';
const engines: any[] = [];

function result(snapshot: any, thinkTime = 500) {
  return {
    type: 'FAST_RESULT',
    requestId: 1,
    generation: snapshot.generation,
    fence: snapshot.fence,
    decision: { action: 'bet', amount: 20, thinkTime },
    rngBefore: 11,
    rngAfter: 22,
    computeMs: 2,
    governorScale: 1,
    effects: [],
  };
}

function harness(horse = true) {
  const seated = {
    user_id: PLAYER,
    seat_number: 1,
    username: 'Fixture Horse',
    stack: 100,
    is_horse: horse,
    horse_profile: {},
  };
  const hero = {
    user_id: PLAYER,
    seat: 1,
    username: 'Fixture Horse',
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'hearts' },
    ],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const state = {
    currentPlayerSeat: 1,
    currentBet: 0,
    minRaise: 2,
    pot: 10,
    stage: 'flop',
    communityCards: [
      { rank: 'Q', suit: 'hearts' },
      { rank: '7', suit: 'clubs' },
      { rank: '2', suit: 'diamonds' },
    ],
    communityCards2: [],
    communityCards3: [],
    players: [hero, { ...hero, seat: 2, user_id: 'other-player', cards: [] }],
    dealerSeat: 2,
    actionHistory: [],
    pots: [],
  };
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'fixture-lease' });
  engine.handCount = 12;
  engine.tableInfo = { action_time_seconds: 15, big_blind: 2, game_variant: 'nlh' };
  engine.seatedPlayers = [seated];
  engine.hub = { emitEvent: vi.fn() };
  engine.rePushHoleCards = vi.fn(async () => {});
  engine.markProgress = vi.fn();
  engine.humansSeated = () => (horse ? 0 : 1);
  engine.tableFormat = () => 'cash';
  const performAction = vi.fn(
    (
      seat: number,
      action: string,
      amount: number,
      origin: string,
      onAccepted?: (v: any) => void
    ) => {
      onAccepted?.({
        seat,
        userId: PLAYER,
        action,
        amount,
        stage: state.stage,
        timestamp: Date.now(),
      });
      state.currentPlayerSeat = 2;
      return true;
    }
  );
  engine.handController = {
    getState: () => state,
    performAction,
    getAuthoritativeActionState: () => ({
      schemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: state.currentPlayerSeat,
      canAct: state.currentPlayerSeat === 1,
      legalActions: ['fold', 'check', 'bet', 'all_in'],
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 100,
      structure: 'no_limit',
      fixedBetSize: null,
      wagersCapped: false,
    }),
    computeLivePots: () => [{ amount: 10, eligiblePlayers: [PLAYER, 'other-player'] }],
    getContestablePotForCall: () => 10,
    getChipRulesSnapshot: () => ({ asset: 'chips', chipUnit: 0.01 }),
    getActiveBoardCount: () => 1,
    getRakeConfigSnapshot: () => ({ percent: 10, cap: 5, noFlopNoDrop: true, playerCountCaps: [] }),
  };
  engine.disconnectEngine.configure(TABLE, { disconnectTimeoutSeconds: 30 });
  engine.disconnectEngine.registerPlayer(TABLE, PLAYER);
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20, autoActivate: true });
  engine.timeBankEngine.initializePlayer(TABLE, PLAYER, { remainingSeconds: 40, usesRemaining: 2 });
  return { engine, state, seated, performAction };
}

async function disconnectedTurn(h: ReturnType<typeof harness>) {
  h.engine.disconnectEngine.markDisconnected(TABLE, PLAYER);
  await h.engine.handleTurnChange({ type: 'TURN_CHANGE', seat: 1, availableActions: [] }, [
    h.seated,
  ]);
  expect(worker.decideFast).not.toHaveBeenCalled();
  const deadline = h.engine.disconnectEngine.getFsmState(TABLE, PLAYER).reconnectDeadlineMs;
  expect(deadline).toBeGreaterThan(Date.now());
  return deadline as number;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  worker.decideFast.mockReset().mockImplementation(async (snapshot) => result(snapshot));
  worker.decideDeep.mockReset();
  worker.commitDecisionEffects.mockClear();
});

afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.cancelHorseDecisionWork();
    engine.timeBankEngine.dispose(TABLE);
    engine.preciseTimer.dispose();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a reconnected horse receives its decision on the retained clock', () => {
  it('resumes the worker after the real disconnected-turn and heartbeat callbacks', async () => {
    const h = harness();
    const deadline = await disconnectedTurn(h);
    await vi.advanceTimersByTimeAsync(8_000);
    h.engine.disconnectEngine.heartbeat(TABLE, PLAYER);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.decideFast).toHaveBeenCalledTimes(1);
    expect(h.performAction).toHaveBeenCalledTimes(1);
    expect(h.performAction.mock.calls[0].slice(0, 3)).toEqual([1, 'bet', 20]);
    expect(h.engine.playerTurnStartTime + h.engine.playerTurnDuration * 1000).toBe(deadline);
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(2);
    expect(h.engine.disconnectEngine.getState(TABLE, PLAYER)?.consecutiveTimeouts ?? 0).toBe(0);
  });

  it('fits a long requested tank into the remaining protection without spending a bank', async () => {
    const h = harness();
    worker.decideFast.mockImplementation(async (snapshot) => result(snapshot, 100_000));
    const deadline = await disconnectedTurn(h);
    await vi.advanceTimersByTimeAsync(deadline - Date.now() - 700);
    h.engine.disconnectEngine.heartbeat(TABLE, PLAYER);
    await vi.advanceTimersByTimeAsync(650);
    expect(h.performAction.mock.calls[0]?.slice(0, 3)).toEqual([1, 'bet', 20]);
    expect(Date.now()).toBeLessThan(deadline);
    expect(h.engine.timeBankSuppressedThisTurn).toBe(true);
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(2);
  });

  it('leaves a human on the same deadline without requesting a horse decision', async () => {
    const h = harness(false);
    const deadline = await disconnectedTurn(h);
    await vi.advanceTimersByTimeAsync(8_000);
    h.engine.disconnectEngine.heartbeat(TABLE, PLAYER);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.decideFast).not.toHaveBeenCalled();
    expect(h.performAction).not.toHaveBeenCalled();
    expect(h.engine.playerTurnStartTime + h.engine.playerTurnDuration * 1000).toBe(deadline);
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(2);
  });

  it('cannot apply a delayed worker answer after the authoritative clock resolves the seat', async () => {
    const h = harness();
    let finish!: () => void;
    worker.decideFast.mockImplementation(
      (snapshot) =>
        new Promise((resolve) => {
          finish = () => resolve(result(snapshot));
        })
    );
    const deadline = await disconnectedTurn(h);
    await vi.advanceTimersByTimeAsync(deadline - Date.now() - 700);
    h.engine.disconnectEngine.heartbeat(TABLE, PLAYER);
    expect(worker.decideFast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.performAction).toHaveBeenCalledTimes(1);
    const actions = h.performAction.mock.calls.length;
    finish();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.performAction).toHaveBeenCalledTimes(actions);
    expect(h.performAction.mock.calls.some((c) => c[1] === 'bet')).toBe(false);
  });

  it('refuses an answer after the retained deadline even before the timer enforcement tick', async () => {
    const h = harness();
    let finish!: () => void;
    worker.decideFast.mockImplementation(
      (snapshot) =>
        new Promise((resolve) => {
          finish = () => resolve(result(snapshot));
        })
    );
    const deadline = await disconnectedTurn(h);
    await vi.advanceTimersByTimeAsync(deadline - Date.now() - 700);
    h.engine.disconnectEngine.heartbeat(TABLE, PLAYER);
    await vi.advanceTimersByTimeAsync(800);
    expect(h.performAction).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.performAction).not.toHaveBeenCalled();
    expect(h.engine.preciseTimer.hasTimer(TABLE, PLAYER)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.performAction).toHaveBeenCalledTimes(1);
    expect(h.performAction.mock.calls.some((c) => c[1] === 'bet')).toBe(false);
  });
});
