import { horsePlanContextFromDecision } from '../../../engine/HorsePlanHandIdentity.js';
import { horsePlanHandKey } from '../../../engine/HorseDecisionEffects.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { HorseMind, readScopeOf, type ReadScope } from '../../../engine/HorseMind.js';
import { horseMindHandFromCompletion } from '../../../engine/HorseMindHandIdentity.js';
import { HorseLogic } from '../../../engine/HorseLogic.js';
import { HandController } from '../../../engine/HandController.js';
import { bindHorseObservationIdentity } from '../../../engine/HorseObservationIdentity.js';
import { captureHandSeatGenerations } from '../../../engine/handSeatGeneration.js';
import { seedFastRandom } from '../../../engine/HorseEval.js';
import {
  decodeHorseDecisionReads,
  type HorseDecisionReadFrame,
} from '../../../engine/HorseDecisionReadFrame.js';
import {
  defaultHorseDecisionWorkerDependencies as defaults,
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from '../../../engine/horseDecision/workerRuntime.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type ObserveCompletedHandRequest,
  type HorseDecisionWorkerResponse,
} from '../../../engine/horseDecision/protocol.js';
import type { ActionRecord, SeatPlayer } from '../../../types.js';

const heroId = '11111111-1111-4111-8111-111111111111';
const opponentId = '22222222-2222-4222-8222-222222222222';
const tableId = '33333333-3333-4333-8333-333333333333';
const lease = '44444444-4444-4444-8444-444444444444';
const rec = (
  seat: number,
  action: ActionRecord['action'],
  amount: number,
  stage: ActionRecord['stage'],
  timestamp: number,
  extra: Partial<ActionRecord> = {}
): ActionRecord => ({
  seat,
  userId: seat === 1 ? heroId : opponentId,
  action,
  amount,
  stage,
  timestamp,
  ...extra,
});

// Explicit synthetic public history, not a claim that a DB accepted this hand.
// The fields/order match controller records plus actual accepted-list additions.
function fixture(n = 1, scope: ReadScope | null | undefined = 'holdem:hu') {
  const t = 1700000000000 + n * 100000;
  const controller = [
    rec(1, 'raise', 6, 'preflop', t + 10, { isFullRaise: true }),
    rec(2, 'call', 6, 'preflop', t + 20),
    rec(1, 'bet', 10, 'river', t + 30, { isFullRaise: true }),
    rec(2, 'fold', 0, 'river', t + 40),
  ];
  const observation: ObserveCompletedHandRequest = {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: n,
    generation: 1000000 + n,
    fence: `${tableId}:${1000000 + n}:${lease}:observe`,
    handKey: `${tableId}:${1000000 + n}`,
    committedHandId: '55555555-5555-4555-8555-555555555555',
    bigBlind: 2,
    scope,
    actions: [
      { seat: 1, userId: heroId, action: 'sb', amount: 1, stage: 'preflop', timestamp: t },
      { seat: 2, userId: opponentId, action: 'bb', amount: 2, stage: 'preflop', timestamp: t + 1 },
      ...controller,
      { seat: 1, userId: heroId, action: 'return', amount: 10, stage: 'river', timestamp: t + 41 },
      {
        seat: 0,
        userId: 'system',
        action: 'rit_board_2:As,Ks,Qs,Js,Ts',
        stage: 'river',
        timestamp: t + 42,
      },
    ],
    showdown: null,
  };
  return { controller, observation };
}

function nextDecision(): FastHorseDecisionRequest {
  const player: SeatPlayer = {
    seat: 1,
    user_id: heroId,
    username: 'Horse',
    stack: 94,
    bet: 0,
    totalInvested: 6,
    cards: [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'hearts' },
    ],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const request: FastHorseDecisionRequest = {
    type: 'DECIDE_FAST',
    requestId: 100,
    generation: 100,
    fence: `${tableId}:1000100:1:${lease}:100`,
    decisionKey: '',
    decisionTimeMs: 1700009900000,
    player,
    style: 'balanced',
    mods: {},
    gameState: {
      stateSchemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: 1,
      legalActions: ['fold', 'check', 'bet', 'all_in'],
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 94,
      bettingStructure: 'no_limit',
      fixedBetSize: null,
      wagersCapped: false,
      commitmentCapRemaining: null,
      players: [
        { ...player, cards: [] },
        { ...player, seat: 2, user_id: opponentId, username: 'Opponent', cards: [] },
      ],
      dealtSeatIds: [1, 2],
      communityCards: [
        { rank: 'Q', suit: 'clubs' },
        { rank: '9', suit: 'spades' },
        { rank: '4', suit: 'diamonds' },
      ],
      communityCards2: [],
      communityCards3: [],
      pot: 12,
      contestablePot: 12,
      pots: [{ amount: 12, eligiblePlayers: [heroId, opponentId] }],
      currentBet: 0,
      minRaise: 2,
      stage: 'flop',
      gameVariant: 'nlh',
      gameMode: 'cash',
      format: 'cash',
      bigBlind: 2,
      dealerSeat: 2,
      actionHistory: [
        rec(1, 'raise', 6, 'preflop', 1700009000000, { isFullRaise: true }),
        rec(2, 'call', 6, 'preflop', 1700009000010),
      ],
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      variantRules: {
        holeCardsDealt: 2,
        holeCardsUse: 'any',
        boardCardsUse: 'any',
        deckSize: 52,
        splitLow8OrBetter: false,
      },
    },
  };
  request.decisionKey = buildHorseDecisionKey(request);
  return request;
}

beforeEach(() => {
  HorseMind.reset();
  seedFastRandom(0x8009);
});
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});

describe('actual default worker completed-hand learner', () => {
  it.each(['nlh', 'plo5', 'flh', 'short_deck'] as const)(
    'learns the actual final controller-accepted %s fold without re-counting its earlier raise',
    (variant) => {
      let clock = 1700000000000;
      vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
      const actions: NonNullable<ObserveCompletedHandRequest['actions']> = [];
      const players = nextDecision().gameState.players.map((player) => ({
        ...player,
        stack: 200,
        bet: 0,
        totalInvested: 0,
      }));
      const hc = new HandController(
        {
          tableId,
          handNumber: 1000001,
          gameVariant: variant,
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        },
        players,
        1
      );
      const generations = captureHandSeatGenerations(
        players.map((player) => ({
          user_id: player.user_id,
          seat_id: player.user_id,
          seat_joined_at: '2026-09-12T10:00:00.123456+00:00',
        }))
      );
      const observation = fixture(1, readScopeOf(variant, 2)).observation;
      let completions = 0;
      const unsubscribe = hc.onEvent((event) => {
        if (event.type === 'HAND_COMPLETE') completions++;
        if (event.type === 'FORCED_BETS_POSTED')
          for (const post of event.postings)
            actions.push({
              seat: post.seat,
              userId: post.userId,
              action: post.kind,
              amount: post.amount,
              timestamp: Date.now(),
              stage: 'preflop',
            });
        if (event.type === 'PLAYER_ACTION' && event.record) {
          const action = { ...event.record, publicNode: event.publicNode, origin: event.origin };
          actions.push({
            ...action,
            observationIdentity: bindHorseObservationIdentity(action, actions.length, {
              handId: observation.committedHandId,
              tableId,
              seatGenerations: generations,
            }),
          });
        }
      });
      try {
        hc.start();
        expect(hc.getState().currentPlayerSeat).toBe(1);
        const right = hc.getAuthoritativeActionState(heroId)!;
        expect(right.legalActions).toContain('raise');
        expect(hc.performAction(1, 'raise', right.minRaiseTo!, 'horse_policy')).toBe(true);
        HorseMind.setDecisionScope(observation.scope!);
        HorseMind.observe(
          hc.getState().actionHistory,
          [],
          horseMindHandFromCompletion(observation)
        );
        HorseMind.setDecisionScope(null);
        expect(HorseMind.getStats(heroId)?.hands).toBe(1);
        expect(HorseMind.getStats(opponentId)).toBeUndefined();
        expect(hc.performAction(2, 'fold', undefined, 'player')).toBe(true);
        expect(completions).toBe(1);
        expect(hc.getState().players.reduce((sum, player) => sum + player.stack, 0)).toBe(400);
        observation.actions = actions;
        const before = structuredClone(actions);
        defaults.observeCompletedHand(observation);
        expect(HorseMind.getStats(opponentId)).toMatchObject({ hands: 1, folds: 1, facedAggr: 1 });
        expect(HorseMind.getStats(heroId)).toMatchObject({ hands: 1, vpip: 1, pfr: 1, aggr: 1 });
        expect(HorseMind.getScopedStats(opponentId, readScopeOf(variant, 2))?.folds).toBe(1);
        expect(actions).toEqual(before);
        const final = actions.find((action) => action.action === 'fold')!;
        expect(final.observationIdentity).toMatchObject({
          status: 'bound',
          actionOrdinal: actions.indexOf(final),
        });
        defaults.observeCompletedHand(observation);
        expect(HorseMind.getStats(opponentId)?.folds).toBe(1);
        expect(completions).toBe(1);
      } finally {
        unsubscribe();
      }
    }
  );

  it('fills the final river fold after a previously observed controller prefix, once', () => {
    const { controller, observation } = fixture();
    HorseMind.setDecisionScope('holdem:hu');
    HorseMind.observe(controller.slice(0, 3), [], horseMindHandFromCompletion(observation));
    HorseMind.setDecisionScope(null);
    expect(HorseMind.getStats(opponentId)?.folds).toBe(0);
    defaults.observeCompletedHand(observation);
    expect(HorseMind.getStats(opponentId)).toMatchObject({
      hands: 1,
      vpip: 1,
      passive: 1,
      folds: 1,
      facedAggr: 2,
      riverBetOpps: 1,
      riverBetFolds: 1,
    });
    expect(HorseMind.getStats(heroId)).toMatchObject({ hands: 1, vpip: 1, pfr: 1, aggr: 2 });
    expect(HorseMind.getScopedStats(opponentId, 'holdem:hu')).toMatchObject({
      hands: 1,
      folds: 1,
      facedAggr: 2,
    });
    expect(HorseMind.getStats('system')).toBeUndefined();
    const before = HorseMind.snapshotDecisionReads(nextDecision().gameState.players, null);
    defaults.observeCompletedHand({ ...observation, requestId: 99 });
    expect(HorseMind.snapshotDecisionReads(nextDecision().gameState.players, null)).toEqual(before);
    expect(HorseMind.currentScope()).toBeNull();
  });

  it('retains the whole final pair response after the last Horse choice', () => {
    const { observation } = fixture();
    observation.actions = [
      rec(1, 'raise', 6, 'preflop', 1700000000001, { isFullRaise: true }),
      rec(2, 'raise', 20, 'preflop', 1700000000002, { isFullRaise: true }),
      rec(1, 'fold', 0, 'preflop', 1700000000003),
    ];
    HorseMind.setDecisionScope('holdem:hu');
    HorseMind.observe(
      [observation.actions[0] as ActionRecord],
      [],
      horseMindHandFromCompletion(observation)
    );
    HorseMind.setDecisionScope(null);
    defaults.observeCompletedHand(observation);
    expect(HorseMind.getPair(opponentId, heroId)).toEqual({ n3: 1, opp3: 1, nR: 0, oppR: 0 });
    expect(HorseMind.getStats(heroId)).toMatchObject({
      hands: 1,
      f3bOpps: 1,
      f3bFolds: 1,
      folds: 1,
    });
    defaults.observeCompletedHand(observation);
    expect(HorseMind.getPair(opponentId, heroId)?.n3).toBe(1);
    expect(HorseMind.getStats(heroId)?.f3bOpps).toBe(1);
  });

  it.each([
    'holdem:hu',
    'holdem:short',
    'holdem:full',
    'omaha:hu',
    'omaha:short',
    'omaha:full',
    'sixplus:hu',
    'sixplus:short',
    'sixplus:full',
  ] as const)(
    'writes the provided completed-hand scope %s and restores the ambient scope',
    (scope) => {
      HorseMind.setDecisionScope('omaha:full');
      defaults.observeCompletedHand(fixture(1, scope).observation);
      expect(HorseMind.getScopedStats(opponentId, scope)?.folds).toBe(1);
      if (scope !== 'omaha:full')
        expect(HorseMind.getScopedStats(opponentId, 'omaha:full')).toBeUndefined();
      expect(HorseMind.currentScope()).toBe('omaha:full');
    }
  );

  it('does not invent basic read data for legacy optional-field histories', () => {
    const { observation } = fixture();
    observation.actions = [
      { userId: heroId, action: 'raise', amount: 6, stage: 'preflop' },
      { userId: opponentId, action: 'raise', amount: 20, stage: 'preflop' },
      { userId: heroId, action: 'fold', stage: 'preflop' },
    ];
    defaults.observeCompletedHand(observation);
    expect(HorseMind.getStats(heroId)).toMatchObject({
      hands: 0,
      vpip: 0,
      folds: 0,
      f3bOpps: 1,
      f3bFolds: 1,
    });
    expect(HorseMind.getStats(opponentId)).toBeUndefined();
  });

  it('restores scope even when the basic learner throws', () => {
    HorseMind.setDecisionScope('sixplus:full');
    vi.spyOn(HorseMind, 'observe').mockImplementationOnce(() => {
      throw Error('injected read failure');
    });
    expect(() => defaults.observeCompletedHand(fixture().observation)).toThrow(
      'injected read failure'
    );
    expect(HorseMind.currentScope()).toBe('sixplus:full');
  });

  it('keeps absent-scope new basic counters pooled without inheriting an ambient scope', () => {
    HorseMind.setDecisionScope('omaha:full');
    const { observation } = fixture();
    delete observation.scope;
    defaults.observeCompletedHand(observation);
    expect(HorseMind.getStats(opponentId)?.folds).toBe(1);
    expect(HorseMind.getScopedStats(opponentId, 'omaha:full')).toBeUndefined();
    expect(HorseMind.currentScope()).toBe('omaha:full');
  });

  it.each(['cancelled', 'expired'] as const)(
    'preserves queued %s refusal without applying or ACKing the completion',
    async (reason) => {
      const responses: HorseDecisionWorkerResponse[] = [];
      const ready = defaults.workerReadiness();
      const runtime = new HorseDecisionWorkerRuntime((response) => responses.push(response), {
        ...defaults,
        startServices: async () => ready,
        stopServices: async () => {},
        journalEnabled: () => false,
        journalAcceptedHand: undefined,
        noteFeature: () => {},
      });
      try {
        const { observation } = fixture();
        runtime.receive(observation);
        runtime.receive({ type: 'CANCEL', requestId: observation.requestId, reason });
        await runtime.drain();
        expect(
          responses.some((r) => r.type === 'CANCELLED' && r.requestId === observation.requestId)
        ).toBe(true);
        expect(responses.some((r) => r.type === 'ACK')).toBe(false);
        expect(HorseMind.getStats(opponentId)).toBeUndefined();
      } finally {
        runtime.receive({ type: 'SHUTDOWN' });
        await runtime.drain();
      }
    }
  );

  it('serializes completed tails ahead of the next real HorseLogic call and retains the actual consumed read frame', async () => {
    const responses: HorseDecisionWorkerResponse[] = [];
    const captures: Array<{
      decision: ReturnType<typeof HorseLogic.decide>;
      readFrame: HorseDecisionReadFrame | null;
    }> = [];
    const reading = vi.spyOn(HorseMind, 'tableExploit'); // pass-through; no policy or read result mocked
    let actualDecisions = 0;
    const ready = defaults.workerReadiness();
    const deps: HorseDecisionWorkerDependencies = {
      ...defaults,
      startServices: async () => ready,
      stopServices: async () => {},
      journalEnabled: () => true,
      journalDecision: (_request, capture) => {
        expect(capture).not.toBeNull();
        expect(typeof capture).toBe('object');
        captures.push(capture as (typeof captures)[number]);
      },
      journalExecution: undefined,
      journalAcceptedHand: undefined,
      journalLifecycle: undefined,
      journalDiscard: undefined,
      journalDiscardExecution: undefined,
      noteDecision: () => {},
      noteFeature: () => {},
      decide: (...args) => {
        actualDecisions++;
        return HorseLogic.decide(...args);
      },
    };
    const runtime = new HorseDecisionWorkerRuntime((response) => responses.push(response), deps);
    try {
      // The learned final fold must be present in the real reader and its
      // retained frame. No success or causal action change is inferred from ACK.
      HorseMind.importStats([{ user_id: opponentId, hands: 30, folds: 7, facedAggr: 7 }]);
      const { observation, controller } = fixture();
      HorseMind.setDecisionScope('holdem:hu');
      HorseMind.observe(controller.slice(0, 3), [], horseMindHandFromCompletion(observation));
      HorseMind.setDecisionScope(null);
      runtime.receive(observation);
      const request = nextDecision();
      runtime.receive(request);
      await runtime.drain();
      expect(responses.filter((r) => r.type === 'ERROR')).toEqual([]);
      expect(
        responses.filter((r) => r.type === 'ACK' || r.type === 'FAST_RESULT').map((r) => r.type)
      ).toEqual(['ACK', 'FAST_RESULT']);
      expect(actualDecisions).toBe(1);
      expect(reading).toHaveBeenCalled();
      expect(
        reading.mock.results.some((result) => result.type === 'return' && result.value.bluffMod > 1)
      ).toBe(true);
      expect(captures).toHaveLength(1);
      expect(captures[0].decision.policyFallback).not.toBe('brain_exception');
      const frame = captures[0].readFrame;
      expect(frame).not.toBeNull();
      const reads = decodeHorseDecisionReads(
        frame!,
        request.gameState.players,
        horsePlanHandKey(request.gameState.actionHistory, horsePlanContextFromDecision(request)),
        horsePlanContextFromDecision(request)
      );
      expect(reads.stats.get(opponentId)).toMatchObject({ folds: 8, facedAggr: 10, hands: 32 });
      expect(reads.scoped.get(`${readScopeOf('nlh', 2)}|${opponentId}`)?.folds).toBe(1);
      expect(HorseMind.currentScope()).toBeNull();
    } finally {
      runtime.receive({ type: 'SHUTDOWN' });
      await runtime.drain();
    }
  });
});

// New coordinate controls. These deliberately use the real HorseLogic default
// path while replacing only external-service startup and journal I/O.
async function runIdentityDecisions(requests: FastHorseDecisionRequest[]) {
  const responses: HorseDecisionWorkerResponse[] = [];
  const ready = defaults.workerReadiness();
  const runtime = new HorseDecisionWorkerRuntime((response) => responses.push(response), {
    ...defaults,
    startServices: async () => ready,
    stopServices: async () => {},
    journalEnabled: () => false,
    journalDecision: undefined,
    journalAcceptedHand: undefined,
    journalLifecycle: undefined,
    noteFeature: () => {},
    noteDecision: () => {},
  });
  try {
    requests.forEach((request) => runtime.receive(request));
    await runtime.drain();
    return responses;
  } finally {
    runtime.receive({ type: 'SHUTDOWN' });
    await runtime.drain();
  }
}

describe('the worker owns basic hand-coordinate admission', () => {
  it('uses the owned delivered snapshot after caller mutation across the actual Node message boundary', async () => {
    const responses: HorseDecisionWorkerResponse[] = [];
    const ready = defaults.workerReadiness();
    const runtime = new HorseDecisionWorkerRuntime((response) => responses.push(response), {
      ...defaults,
      startServices: async () => ready,
      stopServices: async () => {},
      journalEnabled: () => false,
      journalDecision: undefined,
      journalAcceptedHand: undefined,
      journalLifecycle: undefined,
      noteFeature: () => {},
      noteDecision: () => {},
    });
    const { port1, port2 } = new MessageChannel();
    // Register the actual terminal events before either port can close.
    const portsClosed = Promise.all(
      [port1, port2].map(
        (port) => new Promise<void>((resolve) => port.once('close', () => resolve()))
      )
    );
    try {
      const request = nextDecision();
      const originalFence = request.fence;
      const delivered = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (received: boolean, error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(deliveryTimer);
          port2.off('message', onMessage);
          port2.off('messageerror', onError);
          port2.off('close', onClose);
          if (received) resolve();
          else reject(error);
        };
        const onMessage = (owned: FastHorseDecisionRequest) => {
          try {
            runtime.receive(owned);
            finish(true);
          } catch (error) {
            finish(false, error);
          }
        };
        const onError = (error: unknown) => finish(false, error);
        const onClose = () => finish(false, Error('Message port closed before fixture delivery'));
        const deliveryTimer = setTimeout(
          () => finish(false, Error('Message delivery exceeded the fixture deadline')),
          1000
        );
        port2.once('message', onMessage);
        port2.once('messageerror', onError);
        port2.once('close', onClose);
      });
      // Await below still observes rejection. If postMessage itself throws,
      // closing the ports must not leave a second unhandled delivery rejection.
      void delivered.catch(() => {});
      port1.postMessage(request);
      request.fence = `66666666-6666-4666-8666-666666666666:1000200:2:${lease}:101`;
      request.generation = 101;
      request.player.seat = 2;
      request.gameState.actionHistory!.length = 0;
      await delivered;
      await runtime.drain();
      expect(responses.filter((response) => response.type === 'ERROR')).toEqual([]);
      expect(responses.find((response) => response.type === 'FAST_RESULT')).toMatchObject({
        fence: originalFence,
        generation: 100,
      });
      expect(HorseMind.getStats(heroId)).toMatchObject({ hands: 1, vpip: 1, pfr: 1 });
      expect(HorseMind.getStats(opponentId)).toMatchObject({ hands: 1, passive: 1 });
      // Replay under the original coordinate must hit the same delivered keys.
      const original = nextDecision();
      original.requestId = 101;
      runtime.receive(original);
      await runtime.drain();
      expect(responses.filter((response) => response.type === 'FAST_RESULT')).toHaveLength(2);
      expect(HorseMind.getStats(heroId)?.hands).toBe(1);
    } finally {
      port1.close();
      port2.close();
      await portsClosed;
      runtime.receive({ type: 'SHUTDOWN' });
      // Actual runtime drain is joined, not replaced with a local timeout
      // falsely asserting cancellation. The native outer bound remains required.
      await runtime.drain();
    }
  });

  it('does not let caller options replace the coordinate even with a recomputed input key', async () => {
    const request = nextDecision();
    request.opts = { mindObservationHand: { version: 1, tableId, handNumber: 1000100 } } as never;
    request.decisionKey = buildHorseDecisionKey(request);
    const responses = await runIdentityDecisions([request]);
    expect(responses.find((response) => response.type === 'ERROR')).toMatchObject({
      requestId: 100,
      recoverable: true,
    });
    expect(responses.some((response) => response.type === 'FAST_RESULT')).toBe(false);
    expect(HorseMind.getStats(heroId)).toBeUndefined();
  });

  it('continues a legal legacy decision without silently using global basic-read keys', async () => {
    const request = nextDecision();
    request.fence = `${tableId}:100:1:${lease}:100`;
    request.decisionKey = buildHorseDecisionKey(request);
    const responses = await runIdentityDecisions([request]);
    expect(responses.filter((response) => response.type === 'ERROR')).toEqual([]);
    expect(responses.some((response) => response.type === 'FAST_RESULT')).toBe(true);
    expect(HorseMind.getStats(heroId)).toBeUndefined();
    expect(HorseMind.getStats(opponentId)).toBeUndefined();
  });

  it('feeds identical actor/action clocks from two tables as two hands before real decision reads', async () => {
    const first = nextDecision(),
      second = structuredClone(first);
    second.requestId = 101;
    second.generation = 101;
    second.fence = `66666666-6666-4666-8666-666666666666:1000101:1:${lease}:101`;
    second.decisionKey = buildHorseDecisionKey(second);
    const responses = await runIdentityDecisions([first, second]);
    expect(responses.filter((response) => response.type === 'ERROR')).toEqual([]);
    expect(responses.filter((response) => response.type === 'FAST_RESULT')).toHaveLength(2);
    expect(HorseMind.getStats(heroId)).toMatchObject({ hands: 2, vpip: 2, pfr: 2 });
    expect(HorseMind.getStats(opponentId)).toMatchObject({ hands: 2, vpip: 2, passive: 2 });
    expect(HorseMind.currentScope()).toBeNull();
  });
});
