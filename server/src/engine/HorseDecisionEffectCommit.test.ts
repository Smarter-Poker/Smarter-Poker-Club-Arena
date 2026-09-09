import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decisionWorker = vi.hoisted(() => {
  const commitDecisionEffects = vi.fn(async (authority: { generation: number; fence: string }) => ({
    type: 'ACK' as const,
    requestId: 999,
    ...authority,
    operation: 'COMMIT_DECISION_EFFECTS' as const,
  }));
  const decideFast = vi.fn(async (snapshot: { generation: number; fence: string }) => ({
    type: 'FAST_RESULT' as const,
    requestId: 1,
    generation: snapshot.generation,
    fence: snapshot.fence,
    decision: { action: 'bet' as const, amount: 20, thinkTime: 1 },
    rngBefore: 11,
    rngAfter: 22,
    computeMs: 2,
    governorScale: 1,
    effects: [
      {
        type: 'raise_plan' as const,
        handKey: 'table:hand',
        userId: 'horse-1',
        street: 'flop',
        plan: 'foldToRaise' as const,
      },
    ],
  }));
  const worker = {
    decideFast,
    decideDeep: vi.fn(),
    commitDecisionEffects,
    runWithDispatchBarrier: vi.fn(<T>(fn: () => T): T => fn()),
  };
  return { worker, decideFast, commitDecisionEffects };
});

vi.mock('./horseDecision/index.js', async () => {
  const actual = await vi.importActual<typeof import('./horseDecision/index.js')>(
    './horseDecision/index.js'
  );
  return {
    ...actual,
    getLiveHorseDecisionWorker: () => decisionWorker.worker,
  };
});

import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'fafafafa-fafa-fafa-fafa-fafafafafafa';

function harness(intendedActionAccepted: boolean) {
  const player = {
    seat_number: 1,
    user_id: 'horse-1',
    username: 'Horse One',
    stack: 100,
    is_horse: true,
    horse_profile: {},
  };
  const enginePlayer = {
    seat: 1,
    user_id: player.user_id,
    username: player.username,
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
    communityCards: [
      { rank: 'Q', suit: 'hearts' },
      { rank: '7', suit: 'clubs' },
      { rank: '2', suit: 'diamonds' },
    ],
    stage: 'flop' as const,
    players: [
      enginePlayer,
      {
        ...enginePlayer,
        seat: 2,
        user_id: 'human-2',
        username: 'Human Two',
        cards: [
          { rank: 'J', suit: 'spades' },
          { rank: 'J', suit: 'diamonds' },
        ],
      },
    ],
    communityCards2: [],
    communityCards3: [],
    pots: [],
    dealerSeat: 2,
    actionHistory: [],
  };
  const performAction = vi.fn().mockReturnValueOnce(intendedActionAccepted).mockReturnValue(true);
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.handCount = 12;
  engine.tableInfo = { action_time_seconds: 15, big_blind: 2, game_variant: 'nlh' };
  engine.seatedPlayers = [player];
  engine.handController = {
    getState: () => state,
    getAuthoritativeActionState: () => ({
      schemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: 1,
      canAct: true,
      legalActions: ['fold', 'check', 'bet', 'all_in'],
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 100,
      structure: 'no_limit',
      fixedBetSize: null,
      wagersCapped: false,
    }),
    computeLivePots: () => [{ amount: 10, eligiblePlayers: ['horse-1', 'human-2'] }],
    getRakeConfigSnapshot: () => ({
      percent: 10,
      cap: 5,
      noFlopNoDrop: true,
      playerCountCaps: [{ players: 2, cap: 2.5 }],
    }),
    performAction,
  };
  engine.disconnectEngine = { isSittingOut: () => false };
  engine.timeBankEngine = { getPlayerBank: () => null };
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'lease-9' });
  engine.humansSeated = () => 0;
  engine.tableFormat = () => 'cash';
  engine.markProgress = vi.fn();
  return { engine, player, enginePlayer, state, performAction };
}

beforeEach(() => {
  vi.useFakeTimers();
  decisionWorker.decideFast.mockClear();
  decisionWorker.commitDecisionEffects.mockClear();
  decisionWorker.worker.runWithDispatchBarrier.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('authoritative horse action effect commit', () => {
  it('publishes one canonical public state and never exposes any seat private cards', () => {
    const { engine, player, enginePlayer, state } = harness(true);

    engine.scheduleHorseAction(player, 1, enginePlayer, state);

    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.player.cards).toEqual(enginePlayer.cards);
    expect(snapshot.gameState.players).toHaveLength(2);
    expect(snapshot.gameState.players.every((seat: any) => seat.cards.length === 0)).toBe(true);
    expect(snapshot.gameState).toMatchObject({
      stateSchemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: 1,
      legalActions: ['fold', 'check', 'bet', 'all_in'],
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 100,
      bettingStructure: 'no_limit',
      commitmentCapRemaining: null,
      pots: [{ amount: 10, eligiblePlayers: ['horse-1', 'human-2'] }],
      rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
      variantRules: { holeCardsDealt: 2, holeCardsUse: 'any', deckSize: 52 },
    });
    expect(snapshot.decisionKey).toContain('"schemaVersion":1');
    expect(snapshot.decisionKey).not.toContain('"rank":"J"');
  });

  it('removes a false all-in and clamps the wager ceiling at a table commitment cap', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    engine.tableInfo = {
      ...engine.tableInfo,
      cap_enabled: true,
      cap_bb: 10,
    };
    enginePlayer.totalInvested = 15;

    engine.scheduleHorseAction(player, 1, enginePlayer, state);

    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.commitmentCapRemaining).toBe(5);
    expect(snapshot.gameState.maxRaiseTo).toBe(5);
    expect(snapshot.gameState.legalActions).toEqual(['fold', 'check', 'bet']);
  });

  it('commits one captured plan only after the intended wager is accepted', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenCalledTimes(1);
    expect(performAction).toHaveBeenCalledWith(1, 'bet', 20);
    expect(decisionWorker.commitDecisionEffects).toHaveBeenCalledTimes(1);
    expect(decisionWorker.commitDecisionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ generation: expect.any(Number), fence: expect.any(String) }),
      [expect.objectContaining({ type: 'raise_plan', handKey: 'table:hand' })]
    );
  });

  it('does not commit an intended wager plan when that wager is rejected and degraded', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(false);

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenNthCalledWith(1, 1, 'bet', 20);
    expect(performAction).toHaveBeenNthCalledWith(2, 1, 'check');
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });
});
