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
import { HorseDecisionAbortedError, HorseDecisionExpiredError } from './horseDecision/index.js';

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
    getContestablePotForCall: () => 10,
    getRakeConfigSnapshot: () => ({
      percent: 10,
      cap: 5,
      noFlopNoDrop: true,
      playerCountCaps: [{ players: 2, cap: 2.5 }],
    }),
    performAction,
  };
  engine.disconnectEngine = { isSittingOut: () => false };
  engine.timeBankEngine = {
    isArmed: () => false,
    getPlayerBank: () => null,
  };
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
      contestablePot: 10,
      pots: [{ amount: 10, eligiblePlayers: ['horse-1', 'human-2'] }],
      rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
      variantRules: { holeCardsDealt: 2, holeCardsUse: 'any', deckSize: 52 },
    });
    expect(snapshot.decisionKey).toMatch(/^phase5-v1:[0-9a-f]{64}$/);
    expect(snapshot.decisionKey).not.toContain('"rank":"J"');
  });

  it('publishes the legal two-card Pineapple flop after the hero discard', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    engine.tableInfo = { ...engine.tableInfo, game_variant: 'pineapple' };
    engine.handController.getGameVariant = () => 'pineapple';
    enginePlayer.cards = [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'hearts' },
    ];
    (state as any).actionHistory = [
      {
        seat: 1,
        userId: 'horse-1',
        action: 'discard',
        amount: 0,
        timestamp: 100,
        stage: 'pineapple_discard',
      },
    ];

    engine.scheduleHorseAction(player, 1, enginePlayer, state);

    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.player.cards).toHaveLength(2);
    expect(snapshot.gameState).toMatchObject({
      gameVariant: 'pineapple',
      stage: 'flop',
      actionHistory: [
        {
          seat: 1,
          userId: 'horse-1',
          action: 'discard',
          stage: 'pineapple_discard',
        },
      ],
      variantRules: {
        holeCardsDealt: 3,
        holeCardsUse: 'discard_to_two',
        boardCardsUse: 'any',
      },
    });
  });

  it('never schedules an ordinary fast decision during the Pineapple discard round', async () => {
    const { engine, player, state } = harness(true);
    engine.tableInfo = { ...engine.tableInfo, game_variant: 'pineapple' };
    (state as any).stage = 'pineapple_discard';
    (state as any).currentPlayerSeat = 1;

    await engine.handleTurnChange({ type: 'TURN_CHANGE', seat: 1, availableActions: [] }, [player]);

    expect(decisionWorker.decideFast).not.toHaveBeenCalled();
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

  it('publishes the cap-safe all-in-or-fold menu before the worker evaluates it', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    engine.tableInfo = {
      ...engine.tableInfo,
      all_in_or_fold: true,
      cap_enabled: true,
      cap_bb: 10,
    };
    (state as any).stage = 'preflop';
    enginePlayer.totalInvested = 15;

    engine.scheduleHorseAction(player, 1, enginePlayer, state);

    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.commitmentCapRemaining).toBe(5);
    expect(snapshot.gameState.legalActions).toEqual(['check']);
    expect(snapshot.gameState.minRaiseTo).toBeNull();
    expect(snapshot.gameState.maxRaiseTo).toBeNull();
  });

  it('keeps the host non-fold-to-shove belt when the canonical AoF menu allows it', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    engine.tableInfo = { ...engine.tableInfo, all_in_or_fold: true };
    (state as any).stage = 'preflop';
    decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
      type: 'FAST_RESULT' as const,
      requestId: 40,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: { action: 'bet' as const, amount: 20, thinkTime: 1 },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    }));

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenCalledWith(1, 'all_in', undefined);
  });

  it('never resurrects an all-in removed from the canonical AoF menu by the cap', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    engine.tableInfo = {
      ...engine.tableInfo,
      all_in_or_fold: true,
      cap_enabled: true,
      cap_bb: 10,
    };
    (state as any).stage = 'preflop';
    enginePlayer.totalInvested = 15;
    decisionWorker.decideFast.mockImplementationOnce(
      async (snapshot: any) =>
        ({
          type: 'FAST_RESULT' as const,
          requestId: 41,
          generation: snapshot.generation,
          fence: snapshot.fence,
          decision: { action: 'all_in' as const, thinkTime: 1 },
          rngBefore: 11,
          rngAfter: 22,
          computeMs: 2,
          governorScale: 1,
          effects: [],
        }) as any
    );

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenCalledTimes(1);
    expect(performAction).toHaveBeenCalledWith(1, 'check', undefined);
    expect(performAction.mock.calls.some(([, action]) => action === 'all_in')).toBe(false);
  });

  it.each([
    [true, 'intended', 'bet'],
    [false, 'fallback', 'check'],
  ] as const)(
    'records the authoritative Phase 7 execution receipt (%s -> %s)',
    async (accepted, expectedStatus, expectedAction) => {
      const { engine, player, enginePlayer, state, performAction } = harness(accepted);
      const receipt: any = {
        selectedAction: 'bet',
        selectedAmount: 20,
        executedAction: null,
        executedAmount: null,
        executionStatus: 'pending',
      };
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
        type: 'FAST_RESULT' as const,
        requestId: 41,
        generation: snapshot.generation,
        fence: snapshot.fence,
        decision: {
          action: 'bet' as const,
          amount: 20,
          thinkTime: 1,
          tournamentUtility: receipt,
        },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects: [],
      }));

      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(250);

      expect(receipt.executionStatus).toBe(expectedStatus);
      expect(receipt.executedAction).toBe(expectedAction);
      expect(receipt.executedAmount).toBe(expectedAction === 'bet' ? 20 : null);
      expect(performAction).toHaveBeenCalledTimes(accepted ? 1 : 2);
    }
  );

  it('closes a pending Phase 7 receipt when the authority fence expires before commit', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt: any = {
      selectedAction: 'bet',
      selectedAmount: 20,
      executedAction: null,
      executedAmount: null,
      executionStatus: 'pending',
    };
    decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
      type: 'FAST_RESULT' as const,
      requestId: 42,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: {
        action: 'bet' as const,
        amount: 20,
        thinkTime: 1_000,
        tournamentUtility: receipt,
      },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    }));

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(0);
    engine.handCount += 1;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(receipt.executionStatus).toBe('not_executed');
    expect(receipt.executedAction).toBeNull();
    expect(receipt.executedAmount).toBeNull();
    expect(performAction).not.toHaveBeenCalled();
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

  it('takes the safe action immediately when a queued worker decision expires', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    decisionWorker.decideFast.mockRejectedValueOnce(
      new HorseDecisionExpiredError('queued decision used its complete budget')
    );

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(0);

    expect(performAction).toHaveBeenCalledTimes(1);
    expect(performAction).toHaveBeenCalledWith(1, 'check', undefined);
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });

  it('does not act after a genuine authority abort', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    decisionWorker.decideFast.mockRejectedValueOnce(new HorseDecisionAbortedError());

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(performAction).not.toHaveBeenCalled();
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });
});

// Phase 10 must reconcile through the same real scheduled action boundary.
describe('Phase 10 authoritative execution receipts', () => {
  it.each([
    [true, 'intended', 'bet'],
    [false, 'fallback', 'check'],
  ] as const)(
    'records the authoritative Phase 10 execution receipt (%s -> %s)',
    async (accepted, expectedStatus, expectedAction) => {
      const { engine, player, enginePlayer, state, performAction } = harness(accepted);
      const receipt: any = {
        finalAction: 'bet',
        finalAmount: 20,
        executedAction: null,
        executedAmount: null,
        executionStatus: 'pending',
      };
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
        type: 'FAST_RESULT' as const,
        requestId: 41,
        generation: snapshot.generation,
        fence: snapshot.fence,
        decision: {
          action: 'bet' as const,
          amount: 20,
          thinkTime: 1,
          plo4Policy: receipt,
        },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects: [],
      }));

      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(250);

      expect(receipt.executionStatus).toBe(expectedStatus);
      expect(receipt.executedAction).toBe(expectedAction);
      expect(receipt.executedAmount).toBe(expectedAction === 'bet' ? 20 : null);
      expect(performAction).toHaveBeenCalledTimes(accepted ? 1 : 2);
    }
  );

  it('closes a pending Phase 10 receipt when the authority fence expires before commit', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt: any = {
      finalAction: 'bet',
      finalAmount: 20,
      executedAction: null,
      executedAmount: null,
      executionStatus: 'pending',
    };
    decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
      type: 'FAST_RESULT' as const,
      requestId: 42,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: {
        action: 'bet' as const,
        amount: 20,
        thinkTime: 1_000,
        plo4Policy: receipt,
      },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    }));

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(0);
    engine.handCount += 1;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(receipt.executionStatus).toBe('not_executed');
    expect(receipt.executedAction).toBeNull();
    expect(receipt.executedAmount).toBeNull();
    expect(performAction).not.toHaveBeenCalled();
  });
});
