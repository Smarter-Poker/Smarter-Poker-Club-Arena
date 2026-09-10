import { describe, expect, it } from 'vitest';

import type { HorseDecideOpts } from '../HorseLogic.js';
import type { HorseMindDecisionEffect } from '../HorseMind.js';
import type {
  FastHorseDecisionRequest,
  HorseDecisionWorkerReady,
  HorseDecisionWorkerResponse,
  LiveHorseDecisionSnapshot,
} from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from './workerRuntime.js';

const snapshot: LiveHorseDecisionSnapshot = {
  generation: 4,
  fence: 'table:hand:turn',
  decisionKey: '',
  decisionTimeMs: 3_599_999,
  player: {
    seat: 2,
    user_id: 'horse-2',
    username: 'Horse Two',
    stack: 88,
    bet: 2,
    totalInvested: 2,
    cards: [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'spades' },
      { rank: 'Q', suit: 'hearts' },
      { rank: 'J', suit: 'hearts' },
    ],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  },
  gameState: {
    stateSchemaVersion: 1,
    heroSeat: 2,
    currentPlayerSeat: 2,
    legalActions: ['fold', 'call', 'raise', 'all_in'],
    toCall: 2,
    minRaiseTo: 8,
    maxRaiseTo: 11,
    bettingStructure: 'pot_limit',
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
    players: [
      {
        seat: 2,
        user_id: 'horse-2',
        username: 'Horse Two',
        stack: 88,
        bet: 2,
        totalInvested: 2,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 3,
        user_id: 'horse-3',
        username: 'Horse Three',
        stack: 96,
        bet: 4,
        totalInvested: 4,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ],
    communityCards: [],
    communityCards2: [],
    communityCards3: [],
    pot: 6,
    contestablePot: 6,
    currentBet: 4,
    minRaise: 4,
    stage: 'preflop',
    gameVariant: 'plo4',
    bigBlind: 2,
    actionHistory: [],
    pots: [
      { amount: 4, eligiblePlayers: ['horse-2', 'horse-3'] },
      { amount: 2, eligiblePlayers: ['horse-3'] },
    ],
    rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
    variantRules: {
      holeCardsDealt: 4,
      holeCardsUse: 'exactly_two',
      boardCardsUse: 'exactly_three',
      deckSize: 52,
      splitLow8OrBetter: false,
    },
  },
};
snapshot.decisionKey = buildHorseDecisionKey(snapshot);

const governor = () => ({
  enabled: true,
  scale: 0.2,
  p50Ms: 350,
  p99Ms: 500,
  sampledAt: 99,
  throttledForS: 12,
  stale: false,
  timerLateMs: 40,
});

const V31_DATASET = {
  id: '11111111-1111-4111-8111-111111111111',
  checksum: 'a'.repeat(64),
};

function harness() {
  const messages: HorseDecisionWorkerResponse[] = [];
  const restored: number[] = [];
  const decisionOpts: HorseDecideOpts[] = [];
  const decisionsAtRng: number[] = [];
  const features: string[] = [];
  const latency: Array<{ scope: string; ms: number }> = [];
  const observations: string[] = [];
  const appliedEffects: HorseMindDecisionEffect[][] = [];
  const frozenSnapshots: boolean[] = [];
  let capturedEffects: HorseMindDecisionEffect[] = [];
  let rng = 101;
  let started = 0;
  let stopped = 0;
  let now = 10;
  let throwDecision = false;
  const deps: HorseDecisionWorkerDependencies = {
    async startServices() {
      started++;
      return {
        solverStores: {
          charts: 7,
          postflop: 8,
          postflopV31: 9,
          postflopV31Dataset: V31_DATASET,
        },
        solverPolicyArtifact: {
          totalPolicies: 12,
        } as HorseDecisionWorkerReady['solverPolicyArtifact'],
        governor: governor(),
      };
    },
    async stopServices() {
      stopped++;
    },
    decide(_player, _gameState, _style, _mods, opts) {
      decisionOpts.push(opts ?? {});
      decisionsAtRng.push(rng);
      frozenSnapshots.push(
        Object.isFrozen(_player) &&
          Object.isFrozen(_player.cards) &&
          Object.isFrozen(_gameState) &&
          Object.isFrozen(_gameState.players)
      );
      rng = 202;
      if (throwDecision) throw new Error('synthetic decision failure');
      return { action: 'call', amount: 4, thinkTime: 2500 };
    },
    decideDiscard: () => {
      decisionsAtRng.push(rng);
      rng = 303;
      return 1;
    },
    captureDecisionEffects<T>(fn: () => T) {
      return { value: fn(), effects: structuredClone(capturedEffects) };
    },
    applyDecisionEffects(effects) {
      appliedEffects.push(structuredClone([...effects]));
    },
    saveRng: () => rng,
    restoreRng(state) {
      restored.push(state);
      rng = state;
    },
    governorScale: () => 0.2,
    workerReadiness: () => ({
      solverStores: {
        charts: 17,
        postflop: 18,
        postflopV31: 19,
        postflopV31Dataset: V31_DATASET,
      },
      solverPolicyArtifact: {
        totalPolicies: 22,
      } as HorseDecisionWorkerReady['solverPolicyArtifact'],
      governor: { ...governor(), scale: 0.08, sampledAt: 199 },
    }),
    observeCompletedHand(request) {
      observations.push(request.handKey);
    },
    noteDecision(scope, ms) {
      latency.push({ scope, ms });
    },
    noteFeature(feature) {
      features.push(feature);
    },
    now() {
      const value = now;
      now += 6;
      return value;
    },
  };
  const runtime = new HorseDecisionWorkerRuntime((message) => messages.push(message), deps);
  return {
    runtime,
    messages,
    restored,
    decisionOpts,
    decisionsAtRng,
    features,
    latency,
    observations,
    appliedEffects,
    frozenSnapshots,
    started: () => started,
    stopped: () => stopped,
    rng: () => rng,
    setRng: (value: number) => {
      rng = value;
    },
    setThrowDecision: (value: boolean) => {
      throwDecision = value;
    },
    setCapturedEffects: (effects: HorseMindDecisionEffect[]) => {
      capturedEffects = effects;
    },
  };
}

const fastRequest = (requestId = 1): FastHorseDecisionRequest => ({
  ...snapshot,
  type: 'DECIDE_FAST',
  requestId,
});

const rekey = (request: FastHorseDecisionRequest): FastHorseDecisionRequest => ({
  ...request,
  decisionKey: buildHorseDecisionKey(request),
});

const pineappleCards = [
  { rank: 'A' as const, suit: 'spades' as const },
  { rank: 'K' as const, suit: 'spades' as const },
  { rank: 'Q' as const, suit: 'hearts' as const },
];

function pineappleRequest(
  stage: 'preflop' | 'flop' | 'pineapple_discard' | 'turn' | 'river',
  cardCount: 2 | 3,
  discardProof = stage === 'flop' || stage === 'turn' || stage === 'river'
): FastHorseDecisionRequest {
  const actionHistory = discardProof
    ? [
        {
          seat: 2,
          userId: 'horse-2',
          action: 'discard' as const,
          amount: 0,
          timestamp: 100,
          stage: 'pineapple_discard' as const,
        },
      ]
    : [];
  const boardCount = stage === 'preflop' ? 0 : stage === 'turn' ? 4 : stage === 'river' ? 5 : 3;
  return rekey({
    ...fastRequest(),
    player: { ...snapshot.player, cards: pineappleCards.slice(0, cardCount) },
    gameState: {
      ...snapshot.gameState,
      gameVariant: 'pineapple',
      stage,
      bettingStructure: 'no_limit',
      communityCards: (
        [
          { rank: '2', suit: 'clubs' },
          { rank: '7', suit: 'diamonds' },
          { rank: '9', suit: 'hearts' },
          { rank: 'T', suit: 'clubs' },
          { rank: 'J', suit: 'diamonds' },
        ] as const
      ).slice(0, boardCount),
      actionHistory,
      variantRules: {
        holeCardsDealt: 3,
        holeCardsUse: 'discard_to_two',
        boardCardsUse: 'any',
        deckSize: 52,
        splitLow8OrBetter: false,
      },
    },
  });
}

describe('HorseDecisionWorkerRuntime', () => {
  it('gates on owned-service hydration and returns fast RNG/latency/governor receipts', async () => {
    const h = harness();
    h.runtime.receive(fastRequest());
    await h.runtime.drain();

    expect(h.started()).toBe(1);
    expect(h.messages[0]).toEqual({
      type: 'READY',
      solverStores: {
        charts: 7,
        postflop: 8,
        postflopV31: 9,
        postflopV31Dataset: V31_DATASET,
      },
      solverPolicyArtifact: { totalPolicies: 12 },
      governor: governor(),
    });
    expect(h.messages[1]).toMatchObject({
      type: 'FAST_RESULT',
      requestId: 1,
      generation: 4,
      fence: 'table:hand:turn',
      rngBefore: expect.any(Number),
      rngAfter: 202,
      computeMs: 6,
      governorScale: 0.2,
      effects: [],
    });
    expect(h.decisionOpts[0]).toMatchObject({
      telemetry: true,
      decisionTimeMs: 3_599_999,
      observeMind: true,
    });
    expect(h.rng()).toBe(101);
    expect(h.latency).toEqual([{ scope: 'plo4', ms: 6 }]);
    expect(h.features).toEqual(['phase5_canonical_state']);
    expect(h.frozenSnapshots).toEqual([true]);
  });

  it('rejects any private seat card before HorseLogic can read it', async () => {
    const h = harness();
    h.runtime.receive({
      ...fastRequest(),
      gameState: {
        ...snapshot.gameState,
        players: [
          {
            ...snapshot.gameState.players[0],
            cards: [{ rank: 'A', suit: 'spades' }],
          },
        ],
      },
    });
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      requestId: 1,
      message: 'horse state contains private seat cards',
    });
  });

  it('rejects variant rules that disagree with the authoritative variant', async () => {
    const h = harness();
    h.runtime.receive(
      rekey({
        ...fastRequest(),
        gameState: {
          ...snapshot.gameState,
          variantRules: { ...snapshot.gameState.variantRules!, holeCardsUse: 'any' },
        },
      })
    );
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'horse state variant rules do not match gameVariant',
    });
  });

  it.each([
    ['preflop', 3],
    ['flop', 2],
    ['turn', 2],
    ['river', 2],
  ] as const)('accepts the legal Pineapple %s hero-card state', async (stage, cardCount) => {
    const h = harness();
    h.runtime.receive(pineappleRequest(stage, cardCount));
    await h.runtime.drain();

    expect(h.decisionsAtRng).toHaveLength(1);
    expect(h.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId: 1 });
  });

  it.each([
    ['preflop', 2],
    ['flop', 3],
    ['turn', 3],
    ['river', 3],
  ] as const)('rejects the illegal Pineapple %s hero-card state', async (stage, cardCount) => {
    const h = harness();
    h.runtime.receive(pineappleRequest(stage, cardCount));
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'horse state hero card count does not match variant/street rules',
    });
  });

  it('requires the authoritative hero discard before accepting two Pineapple flop cards', async () => {
    const h = harness();
    h.runtime.receive(pineappleRequest('flop', 2, false));
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'horse state pineapple post-discard cards lack authoritative discard proof',
    });
  });

  it('refuses ordinary fast work during the simultaneous Pineapple discard round', async () => {
    const h = harness();
    h.runtime.receive(pineappleRequest('pineapple_discard', 3, false));
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'horse fast decisions cannot run during the pineapple discard round',
    });
  });

  it('binds the authoritative Pineapple discard record into the canonical key', async () => {
    const h = harness();
    const request = pineappleRequest('flop', 2);
    h.runtime.receive({
      ...request,
      gameState: {
        ...request.gameState,
        actionHistory: (request.gameState.actionHistory ?? []).map((action) => ({
          ...action,
          timestamp: action.timestamp + 1,
        })),
      },
    });
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'decisionKey does not bind the canonical decision snapshot',
    });
  });

  it('rejects side-pot eligibility for a player absent from public state', async () => {
    const h = harness();
    h.runtime.receive(
      rekey({
        ...fastRequest(),
        gameState: {
          ...snapshot.gameState,
          pots: [{ amount: 6, eligiblePlayers: ['missing-player'] }],
        },
      })
    );
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'horse state side-pot eligibility is invalid',
    });
  });

  it('rejects a contestable pot that includes an unreachable side pot', async () => {
    const h = harness();
    h.runtime.receive(
      rekey({
        ...fastRequest(),
        gameState: { ...snapshot.gameState, contestablePot: 5 },
      })
    );
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'horse state contestable pot is invalid',
    });
  });

  it('rejects offline candidate selectors at the live worker boundary', async () => {
    const h = harness();
    h.runtime.receive({
      ...fastRequest(),
      opts: { gtoV31DatasetChecksum: 'a'.repeat(64) },
    } as unknown as FastHorseDecisionRequest);
    await h.runtime.drain();

    expect(h.decisionOpts).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      requestId: 1,
      generation: 4,
      fence: 'table:hand:turn',
      message: 'offline V31 candidate controls are forbidden in live decision requests',
    });
  });

  it('replays deep work from rngBefore and always restores canonical worker RNG', async () => {
    const h = harness();
    h.setCapturedEffects([
      { type: 'plan', handKey: 'speculative', userId: 'horse-2', barrelIntent: true },
    ]);
    await h.runtime.start();
    h.setRng(900);
    h.runtime.receive({
      ...snapshot,
      type: 'DECIDE_DEEP',
      requestId: 2,
      rngBefore: 77,
      deepEquity: 6,
    });
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([77]);
    expect(h.restored).toEqual([77, 900]);
    expect(h.rng()).toBe(900);
    expect(h.decisionOpts[0]).toMatchObject({
      telemetry: false,
      deepEquity: 6,
      decisionTimeMs: 3_599_999,
      observeMind: false,
    });
    expect(h.features).toEqual(['v44_second_look']);
    expect(h.latency).toEqual([{ scope: 'deep:plo4', ms: 6 }]);
    expect(h.messages.at(-1)).toMatchObject({ type: 'DEEP_RESULT', requestId: 2 });
    expect(h.appliedEffects).toEqual([]);
  });

  it('restores canonical RNG when deep computation throws and keeps FIFO usable', async () => {
    const h = harness();
    await h.runtime.start();
    h.setRng(444);
    h.setThrowDecision(true);
    h.runtime.receive({
      ...snapshot,
      type: 'DECIDE_DEEP',
      requestId: 3,
      rngBefore: 55,
      deepEquity: 6,
    });
    await h.runtime.drain();

    expect(h.rng()).toBe(444);
    expect(h.restored).toEqual([55, 444]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      requestId: 3,
      generation: 4,
      fence: 'table:hand:turn',
      message: 'synthetic decision failure',
    });
  });

  it('serializes completed-hand learning with decisions and drains services on shutdown', async () => {
    const h = harness();
    h.runtime.receive(fastRequest(1));
    h.runtime.receive({
      type: 'OBSERVE_COMPLETED_HAND',
      requestId: 2,
      generation: 4,
      fence: 'table:hand:complete',
      handKey: 'table:hand',
      actions: [],
      bigBlind: 2,
    });
    h.runtime.receive({ type: 'SHUTDOWN' });
    await h.runtime.drain();

    expect(h.messages.map((message) => message.type)).toEqual([
      'READY',
      'FAST_RESULT',
      'ACK',
      'STOPPED',
    ]);
    expect(h.observations).toEqual(['table:hand']);
    expect(h.stopped()).toBe(1);
  });

  it('applies fast decision effects only through an explicit FIFO commit', async () => {
    const h = harness();
    const effects: HorseMindDecisionEffect[] = [
      {
        type: 'raise_plan',
        handKey: 'table:hand',
        userId: 'horse-2',
        street: 'flop',
        plan: 'foldToRaise',
      },
    ];
    h.setCapturedEffects(effects);
    h.runtime.receive(fastRequest(1));
    h.runtime.receive({
      type: 'COMMIT_DECISION_EFFECTS',
      requestId: 2,
      generation: 4,
      fence: 'table:hand:turn',
      effects,
    });
    await h.runtime.drain();

    expect(h.messages[1]).toMatchObject({ type: 'FAST_RESULT', effects });
    expect(h.appliedEffects).toEqual([effects]);
    expect(h.messages[2]).toMatchObject({
      type: 'ACK',
      operation: 'COMMIT_DECISION_EFFECTS',
    });
  });

  it('returns dynamic worker-owned solver and governor status through the FIFO', async () => {
    const h = harness();
    h.runtime.receive({ type: 'STATUS', requestId: 1, generation: 0, fence: 'worker:status' });
    await h.runtime.drain();

    expect(h.messages.at(-1)).toMatchObject({
      type: 'STATUS_RESULT',
      solverStores: {
        charts: 17,
        postflop: 18,
        postflopV31: 19,
        postflopV31Dataset: V31_DATASET,
      },
      solverPolicyArtifact: { totalPolicies: 22 },
      governor: { scale: 0.08, sampledAt: 199 },
    });
  });

  it('runs Pineapple discard computation in the worker lane', async () => {
    const h = harness();
    h.runtime.receive({
      type: 'DECIDE_DISCARD',
      requestId: 1,
      generation: 4,
      fence: 'table:hand:discard:2',
      cards: [
        { rank: 'A', suit: 'hearts' },
        { rank: 'K', suit: 'hearts' },
        { rank: '2', suit: 'clubs' },
      ],
      communityCards: [],
      gameVariant: 'pineapple',
    });
    await h.runtime.drain();

    expect(h.messages.at(-1)).toMatchObject({
      type: 'DISCARD_RESULT',
      cardIndex: 1,
      computeMs: 6,
      governorScale: 0.2,
    });
    expect(h.rng()).toBe(101);
  });

  it('derives each fast RNG stream from its canonical key, not prior speculative work', async () => {
    const afterOtherWork = harness();
    afterOtherWork.runtime.receive(rekey({ ...fastRequest(1), fence: 'other-table:stale-turn' }));
    afterOtherWork.runtime.receive(rekey({ ...fastRequest(2), fence: 'target-table:owned-turn' }));
    await afterOtherWork.runtime.drain();

    const direct = harness();
    direct.runtime.receive(rekey({ ...fastRequest(1), fence: 'target-table:owned-turn' }));
    await direct.runtime.drain();

    expect(afterOtherWork.decisionsAtRng[1]).toBe(direct.decisionsAtRng[0]);
    expect(afterOtherWork.rng()).toBe(101);
    expect(direct.rng()).toBe(101);
  });

  it('replays the same canonical decision key across worker restarts', async () => {
    const first = harness();
    first.setRng(17);
    first.runtime.receive(fastRequest());
    await first.runtime.drain();

    const restarted = harness();
    restarted.setRng(4_000_000_001);
    restarted.runtime.receive(fastRequest());
    await restarted.runtime.drain();

    expect(first.decisionsAtRng[0]).toBe(restarted.decisionsAtRng[0]);
  });

  it('changes the RNG stream when a bound decision input changes', async () => {
    const balanced = harness();
    balanced.runtime.receive(rekey({ ...fastRequest(1), style: 'balanced' }));
    await balanced.runtime.drain();

    const aggressive = harness();
    aggressive.runtime.receive(rekey({ ...fastRequest(1), style: 'lag' }));
    await aggressive.runtime.drain();

    expect(balanced.decisionsAtRng).toHaveLength(1);
    expect(aggressive.decisionsAtRng).toHaveLength(1);
    expect(balanced.decisionsAtRng[0]).not.toBe(aggressive.decisionsAtRng[0]);
  });

  it('binds profile modifiers, live options and the decision-hour input', () => {
    const base = fastRequest(1);
    const baseKey = buildHorseDecisionKey(base);

    expect(buildHorseDecisionKey({ ...base, mods: { aggression: 1.2 } })).not.toBe(baseKey);
    expect(buildHorseDecisionKey({ ...base, opts: { v20Multiway: false } })).not.toBe(baseKey);
    expect(buildHorseDecisionKey({ ...base, decisionTimeMs: base.decisionTimeMs - 1 })).toBe(
      baseKey
    );
    expect(buildHorseDecisionKey({ ...base, decisionTimeMs: base.decisionTimeMs + 1 })).not.toBe(
      baseKey
    );
  });

  it('rejects a changed snapshot carrying its old decision key', async () => {
    const h = harness();
    h.runtime.receive({ ...fastRequest(1), style: 'lag' });
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'decisionKey does not bind the canonical decision snapshot',
    });
  });

  it('restores canonical RNG when a fast decision throws', async () => {
    const h = harness();
    h.setThrowDecision(true);

    h.runtime.receive(rekey({ ...fastRequest(1), fence: 'throwing-fast-turn' }));
    await h.runtime.drain();

    expect(h.rng()).toBe(101);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      requestId: 1,
      fence: 'throwing-fast-turn',
      message: 'synthetic decision failure',
    });
  });

  it('cancels a FIFO entry before it begins without running HorseLogic', async () => {
    const h = harness();
    h.runtime.receive(fastRequest(1));
    h.runtime.receive({ type: 'CANCEL', requestId: 1 });
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'CANCELLED',
      requestId: 1,
      generation: 4,
      fence: 'table:hand:turn',
    });
  });
});
