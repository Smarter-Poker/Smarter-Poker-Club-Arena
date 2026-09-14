import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastHorseDecisionResult } from './horseDecision/protocol.js';

const decisionWorker = vi.hoisted(() => {
  const commitDecisionEffects = vi.fn(async (authority: { generation: number; fence: string }) => ({
    type: 'ACK' as const,
    requestId: 999,
    ...authority,
    operation: 'COMMIT_DECISION_EFFECTS' as const,
  }));
  const decideFast = vi.fn(
    async (snapshot: { generation: number; fence: string }): Promise<FastHorseDecisionResult> => ({
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
    })
  );
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

import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { ServerTableEngineTurns } from './ServerTableEngineTurns.js';
import { HorseDecisionAbortedError, HorseDecisionExpiredError } from './horseDecision/index.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { createHorseExecutionWitness } from './HorseExecutionWitness.js';

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
    getChipRulesSnapshot: () => ({ asset: 'chips', chipUnit: 0.01 }),
    getActiveBoardCount: () => 1,
    getRakeConfigSnapshot: () => ({
      percent: 10,
      cap: 5,
      noFlopNoDrop: true,
      playerCountCaps: [{ players: 2, cap: 2.5 }],
    }),
    performAction: (...args: any[]) => {
      const applied = performAction(...args.slice(0, 4));
      if (applied) {
        const [seat, action, amount, , onAccepted] = args;
        onAccepted?.({
          seat,
          userId: player.user_id,
          action,
          amount: action === 'all_in' ? enginePlayer.stack + enginePlayer.bet : (amount ?? 0),
          stage: state.stage,
          timestamp: Date.now(),
        });
      }
      return applied;
    },
  };
  engine.disconnectEngine = { isSittingOut: () => false, recordPlayerActed: vi.fn() };
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
  decisionWorker.worker.decideDeep.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('authoritative horse action effect commit', () => {
  it.each(['plo4', 'plo5', 'plo6', 'plo8', 'flh', 'flo8'] as const)(
    'reconciles the actual %s controller clamp through the scheduled executor',
    async (variant) => {
      const { engine, player, enginePlayer } = harness(true);
      const hc = new HandController(
        {
          tableId: TABLE,
          handNumber: 12,
          gameVariant: variant,
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        } as HandConfig,
        [1, 2, 3, 4].map((seat) => ({
          ...enginePlayer,
          seat,
          cards: [],
          user_id: seat === 1 ? player.user_id : `opponent-${seat}`,
        })) as SeatPlayer[],
        2
      );
      hc.start();
      engine.handController = hc;
      engine.tableInfo.game_variant = variant;
      const policies = {
        tournamentUtility: {
          selectedAction: 'all_in',
          selectedAmount: null,
          executionStatus: 'pending',
        },
        tournamentPostflop: {
          applied: false,
          baselineAction: 'all_in',
          baselineAmount: null,
          executionStatus: 'pending',
        },
        plo4Policy: { finalAction: 'all_in', finalAmount: null, executionStatus: 'pending' },
        omahaVariantPolicy: {
          variant,
          finalAction: 'all_in',
          finalAmount: null,
          executionStatus: 'pending',
        },
        remainingVariantPolicy: {
          variant,
          finalAction: 'all_in',
          finalAmount: null,
          executionStatus: 'pending',
        },
        jointPolicy: {
          variant,
          finalAction: 'all_in',
          finalAmount: null,
          executionStatus: 'pending',
        },
      };
      let witness: ReturnType<typeof createHorseExecutionWitness> | undefined;
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => {
        const decision = { action: 'all_in' as const, thinkTime: 1, ...policies } as any;
        witness = createHorseExecutionWitness(snapshot, decision, {
          requestId: 1,
          lane: 'fast',
          computeMs: 2,
          governorScale: 1,
        });
        return {
          type: 'FAST_RESULT',
          requestId: 1,
          generation: snapshot.generation,
          fence: snapshot.fence,
          decision: { ...decision, executionWitness: witness },
          rngBefore: 11,
          rngAfter: 22,
          computeMs: 2,
          governorScale: 1,
          effects: [],
        };
      });
      const state = hc.getState();
      expect(state.currentPlayerSeat).toBe(1);
      engine.scheduleHorseAction(player, 1, state.players.find((p) => p.seat === 1)!, state);
      await vi.advanceTimersByTimeAsync(300);
      const expectedAmount = variant.startsWith('plo') ? 7 : 4;
      expect(witness).toMatchObject({
        executionStatus: 'coerced',
        executedAction: 'raise',
        executedAmount: expectedAmount,
      });
      expect(witness?.acceptedActions).toEqual([
        {
          intended: true,
          record: { seat: 1, action: 'raise', amount: expectedAmount, stage: 'preflop' },
        },
      ]);
      for (const receipt of Object.values(policies)) {
        expect(receipt).toMatchObject({
          executionStatus: 'coerced',
          executedAction: 'raise',
          executedAmount: expectedAmount,
        });
      }
      expect(hc.getState().players.find((p) => p.seat === 1)!.stack).toBe(100 - expectedAmount);
    }
  );
  it('keeps a disconnected all-in seat as a live pot contender', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    state.players[1].is_all_in = true;
    state.players[1].stack = 0;
    engine.disconnectEngine.isSittingOut = (_table: string, userId: string) => userId === 'human-2';
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.players[1]).toMatchObject({ is_all_in: true, is_sitting_out: false });
  });
  it('publishes the controller actual board count after a physical deck downgrade', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    engine.currentHandBombPot = { board_count: 3 };
    engine.handController.getActiveBoardCount = () => 2;
    (state as any).communityCards2 = [
      { rank: '3', suit: 'clubs' },
      { rank: '4', suit: 'diamonds' },
      { rank: '5', suit: 'hearts' },
    ];
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.boardCount).toBe(2);
  });
  it('retains folded disconnected deals without exposing their cards', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    state.players[1].is_folded = true;
    state.players.push({ ...state.players[1], seat: 3, user_id: 'never-dealt', cards: [] });
    engine.disconnectEngine.isSittingOut = (_table: string, userId: string) =>
      userId !== player.user_id;
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.players[1].is_sitting_out).toBe(true);
    expect(snapshot.gameState.dealtSeatIds).toEqual([1, 2]);
    expect(snapshot.gameState.chipUnit).toBe(0.01);
    expect(snapshot.gameState.asset).toBe('chips');
    expect(snapshot.gameState.players.every((seat: any) => seat.cards.length === 0)).toBe(true);
    state.players[1].cards.pop();
    expect(snapshot.gameState.dealtSeatIds).toEqual([1, 2]);
  });

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
    const discarded = [{ rank: 'Q', suit: 'diamonds' }];
    engine.handController.getPineappleKnownDeadCards = vi.fn(() => discarded);
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
    expect(snapshot.player.knownDeadCards).toEqual(discarded);
    expect(engine.handController.getPineappleKnownDeadCards).toHaveBeenCalledWith(1);
    expect(snapshot.gameState.players.every((seat: any) => seat.knownDeadCards === undefined)).toBe(
      true
    );
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

    expect(performAction).toHaveBeenCalledWith(1, 'all_in', undefined, 'horse_policy');
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
    expect(performAction).toHaveBeenCalledWith(1, 'check', undefined, 'horse_policy');
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
      expect(performAction.mock.calls.map((call) => call[3])).toEqual(
        accepted ? ['horse_policy'] : ['horse_policy', 'horse_fallback']
      );
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
    expect(performAction).toHaveBeenCalledWith(1, 'bet', 20, 'horse_policy');
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

    expect(performAction).toHaveBeenNthCalledWith(1, 1, 'bet', 20, 'horse_policy');
    expect(performAction).toHaveBeenNthCalledWith(2, 1, 'check', undefined, 'horse_fallback');
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
    expect(performAction).toHaveBeenCalledWith(1, 'check', undefined, 'horse_fallback');
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

// Phase 11 must reconcile through the same real scheduled action boundary.
describe('Phase 11 authoritative execution receipts', () => {
  it.each(['generation', 'fence'] as const)(
    'retires every ledger on an early %s mismatch without executing an action',
    async (mismatch) => {
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const ledgers = Object.fromEntries(
        ['tournamentUtility', 'tournamentPostflop', 'plo4Policy', 'omahaVariantPolicy'].map(
          (key) => [
            key,
            {
              variant: 'plo8',
              finalAction: 'bet',
              finalAmount: 20,
              executedAction: null,
              executedAmount: null,
              executionStatus: 'pending',
            },
          ]
        )
      );
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
        type: 'FAST_RESULT' as const,
        requestId: 45,
        generation: snapshot.generation + Number(mismatch === 'generation'),
        fence: mismatch === 'fence' ? 'retired-fence' : snapshot.fence,
        decision: { action: 'bet' as const, amount: 20, thinkTime: 1, ...ledgers },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects: [],
      }));
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(250);
      for (const ledger of Object.values(ledgers))
        expect(ledger.executionStatus).toBe('not_executed');
      expect(performAction).not.toHaveBeenCalled();
      expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
    }
  );
  it.each([
    [true, 'intended', 'bet'],
    [false, 'fallback', 'check'],
  ] as const)(
    'records the authoritative Phase 11 execution receipt (%s -> %s)',
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
          omahaVariantPolicy: receipt,
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

  it('closes a pending Phase 11 receipt when the authority fence expires before commit', async () => {
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
        omahaVariantPolicy: receipt,
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

describe.each([
  'tournamentUtility',
  'tournamentPostflop',
  'plo4Policy',
  'omahaVariantPolicy',
  'remainingVariantPolicy',
  'jointPolicy',
  'executionWitness',
] as const)('%s deep and cancelled execution reconciliation', (policyKey) => {
  beforeEach(() => {
    enableBrainTelemetry();
    drainFires();
  });
  const ledger = (action = 'call', amount: number | null = 20) => ({
    variant: 'nlh',
    selectedAction: action,
    selectedAmount: amount,
    baselineAction: action,
    baselineAmount: amount,
    applied: false,
    finalAction: action,
    finalAmount: amount,
    executedAction: null,
    executedAmount: null,
    executionStatus: 'pending',
  });
  const response = (
    snapshot: any,
    receipt: any,
    action: any,
    amount: number | undefined = action === 'call' || action === 'bet' ? 20 : undefined,
    lane: 'fast' | 'deep' = 'fast'
  ) => {
    if (policyKey === 'executionWitness') {
      Object.assign(
        receipt,
        createHorseExecutionWitness(
          snapshot,
          { action, amount, thinkTime: 1000 },
          {
            requestId: 81,
            lane,
            computeMs: 2,
            governorScale: 1,
          }
        )
      );
    }
    return {
      type: 'FAST_RESULT' as const,
      requestId: 81,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: { action, amount, thinkTime: 1000, [policyKey]: receipt },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    };
  };
  it.each(['accepted', 'unchanged', 'generation', 'fence', 'after_commit', 'cancelled'] as const)(
    'reconciles the actual scheduled deep result: %s',
    async (mode) => {
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const fast = ledger(),
        deep = ledger(mode === 'unchanged' ? 'call' : 'fold', mode === 'unchanged' ? 20 : null);
      state.currentBet = 20;
      const authority = engine.handController.getAuthoritativeActionState();
      engine.handController.getAuthoritativeActionState = () => ({
        ...authority,
        legalActions: ['fold', 'call', 'raise', 'all_in'],
        toCall: 20,
        minRaiseTo: 40,
      });
      vi.spyOn(ServerTableEngineTurns, 'secondLookPlan').mockReturnValue({
        ok: true,
        afterMs: 100,
      });
      decisionWorker.decideFast.mockImplementationOnce(async (s: any) => response(s, fast, 'call'));
      let release: (v: any) => void = () => {};
      let deepSnapshot: any;
      decisionWorker.worker.decideDeep.mockImplementationOnce((s: any) => {
        deepSnapshot = s;
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(100);
      expect(decisionWorker.worker.decideDeep).toHaveBeenCalledOnce();
      if (mode === 'after_commit') await vi.advanceTimersByTimeAsync(1000);
      if (mode === 'cancelled') engine.cancelHorseDecisionWork();
      const result = response(
        deepSnapshot,
        deep,
        mode === 'unchanged' ? 'call' : 'fold',
        mode === 'unchanged' ? 20 : undefined,
        'deep'
      );
      if (mode === 'generation') result.generation += 1;
      if (mode === 'fence') result.fence = 'retired';
      release({ ...result, type: 'DEEP_RESULT' });
      await vi.advanceTimersByTimeAsync(1100);
      expect(fast.executionStatus).toBe(
        mode === 'accepted' || mode === 'cancelled' ? 'not_executed' : 'intended'
      );
      expect(deep.executionStatus).toBe(mode === 'accepted' ? 'intended' : 'not_executed');
      if (mode === 'cancelled') expect(performAction).not.toHaveBeenCalled();
      else {
        expect(performAction).toHaveBeenCalledOnce();
        expect(performAction.mock.calls[0][1]).toBe(mode === 'accepted' ? 'fold' : 'call');
      }
      expect(mode === 'accepted' ? fast.executedAction : deep.executedAction).toBeNull();
      const retirementFeature = {
        tournamentUtility: 'phase7_utility_not_executed',
        tournamentPostflop: 'phase8_execution_not_executed',
        plo4Policy: 'phase10_execution_not_executed',
        omahaVariantPolicy: 'phase11_execution_not_executed',
        remainingVariantPolicy: 'phase12_execution_not_executed',
        jointPolicy: 'phase13_execution_not_executed',
        executionWitness: 'phase15_execution_not_executed',
      }[policyKey];
      expect(drainFires().find(({ feature }) => feature === retirementFeature)?.fires).toBe(
        mode === 'cancelled' ? 2 : 1
      );
    }
  );
  it.each(['coerced', 'rejected'] as const)(
    'reports %s at the actual action boundary',
    async (mode) => {
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const receipt = ledger('bet', 20);
      if (mode === 'coerced') {
        engine.tableInfo.all_in_or_fold = true;
        state.stage = 'preflop' as any;
      } else performAction.mockReset().mockReturnValue(false);
      decisionWorker.decideFast.mockImplementationOnce(async (s: any) =>
        response(s, receipt, 'bet')
      );
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(1250);
      expect(receipt.executionStatus).toBe(mode === 'coerced' ? 'coerced' : 'not_executed');
      expect(receipt.executedAction).toBe(mode === 'coerced' ? 'all_in' : null);
    }
  );
  it('retires a cancelled turn immediately even though its action timer never runs', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt = ledger('bet', 20);
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => response(s, receipt, 'bet'));
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(0);
    expect(receipt.executionStatus).toBe('pending');
    engine.cancelHorseDecisionWork();
    expect(engine.horseActionTimer).toBeNull();
    expect(receipt.executionStatus).toBe('not_executed');
    expect(receipt.executedAction).toBeNull();
    expect(receipt.executedAmount).toBeNull();
    engine.cancelHorseDecisionWork();
    await vi.advanceTimersByTimeAsync(2000);
    expect(receipt.executionStatus).toBe('not_executed');
    expect(performAction).not.toHaveBeenCalled();
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });
});

// Each phase reconciles through the same real scheduled action boundary.
describe.each(['remainingVariantPolicy', 'jointPolicy'] as const)(
  '%s authoritative execution receipts',
  (policyKey) => {
    it.each(['generation', 'fence'] as const)(
      'retires every ledger on an early %s mismatch without executing an action',
      async (mismatch) => {
        const { engine, player, enginePlayer, state, performAction } = harness(true);
        const ledgers = Object.fromEntries(
          [
            'tournamentUtility',
            'tournamentPostflop',
            'plo4Policy',
            'omahaVariantPolicy',
            'remainingVariantPolicy',
            'jointPolicy',
          ].map((key) => [
            key,
            {
              variant: 'flo8',
              finalAction: 'bet',
              finalAmount: 20,
              executedAction: null,
              executedAmount: null,
              executionStatus: 'pending',
            },
          ])
        );
        decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
          type: 'FAST_RESULT' as const,
          requestId: 45,
          generation: snapshot.generation + Number(mismatch === 'generation'),
          fence: mismatch === 'fence' ? 'retired-fence' : snapshot.fence,
          decision: { action: 'bet' as const, amount: 20, thinkTime: 1, ...ledgers },
          rngBefore: 11,
          rngAfter: 22,
          computeMs: 2,
          governorScale: 1,
          effects: [],
        }));
        engine.scheduleHorseAction(player, 1, enginePlayer, state);
        await vi.advanceTimersByTimeAsync(250);
        for (const ledger of Object.values(ledgers))
          expect(ledger.executionStatus).toBe('not_executed');
        expect(performAction).not.toHaveBeenCalled();
        expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
      }
    );
    it.each([
      [true, 'intended', 'bet'],
      [false, 'fallback', 'check'],
    ] as const)(
      'records the authoritative Phase 12 execution receipt (%s -> %s)',
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
            [policyKey]: receipt,
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

    it('closes a pending Phase 12 receipt when the authority fence expires before commit', async () => {
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
          [policyKey]: receipt,
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
  }
);
