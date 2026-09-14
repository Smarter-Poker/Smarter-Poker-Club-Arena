import { HorseLogic } from '../HorseLogic.js';
import { jointPolicyFixture } from '../multiway/JointRangeFixture.test-support.js';
import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';

import type { HorseDecideOpts } from '../HorseLogic.js';
import type { HorseMindDecisionEffect } from '../HorseMind.js';
import type {
  FastHorseDecisionRequest,
  HorseDecisionWorkerReady,
  HorseDecisionWorkerResponse,
  LiveHorseDecisionSnapshot,
} from './protocol.js';
import { buildHorseDecisionKey, validatedHorsePolicySamplingKey } from './protocol.js';
import { HORSE_REVIEW_SIGNAL_KEYS } from '../HorseReviewSignals.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from './workerRuntime.js';
import { buildTournamentMState, TOURNAMENT_CONTEXT_INCOMPLETE } from '../HorseTournamentPreflop.js';

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
    gameMode: 'cash',
    format: 'cash',
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

function harness(realDecision = false) {
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
      if (realDecision) return HorseLogic.decide(_player, _gameState, _style, _mods, opts);
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

describe('Phase 13 cross-board worker boundary', () => {
  it.each([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
    'flh',
    'pineapple',
    'short_deck',
  ] as const)(
    '%s carries real shadow analysis or an explicit real-time budget refusal through the live worker',
    async (variant) => {
      const s = jointPolicyFixture(variant, 2, 'cash', 'flop');
      const h = harness(true);
      const request = rekey({
        ...fastRequest(),
        player: s.hero,
        gameState: s.state,
        style: 'balanced',
        mods: {},
        opts: { mind: false },
      });
      h.runtime.receive(request);
      await h.runtime.drain();
      const result = h.messages.find((m) => m.type === 'FAST_RESULT');
      expect(result?.type, JSON.stringify(h.messages)).toBe('FAST_RESULT');
      if (result?.type !== 'FAST_RESULT') return;
      const copy = structuredClone(result);
      expect(copy.decision.jointPolicy).toMatchObject({
        variant,
        mode: 'shadow',
        applied: false,
        executionStatus: 'pending',
      });
      expect(copy.decision.jointPolicy?.finalAction).toBe(copy.decision.action);
      expect(copy.decision.jointPolicy?.completedSamples).toBeGreaterThanOrEqual(0);
      // A contended test runner may exhaust the production deadline; it may
      // never forge an offline clock or serialize private opponent deals.
      expect([
        'work_budget',
        'insufficient_joint_samples',
        'joint_samples_unavailable',
        'joint_cash_action_distribution',
      ]).toContain(copy.decision.jointPolicy?.reason);
      expect(JSON.stringify(copy.decision.jointPolicy)).not.toMatch(
        /"rank"|"suit"|originalHands|availableCards/
      );
      expect(h.decisionOpts[0].phase13EvidenceMode).toBeUndefined();
    }
  );
  const multiboard = () => {
    const request = structuredClone(fastRequest());
    const card = (rank: string, suit: 'clubs' | 'diamonds' | 'hearts') => ({ rank, suit }) as const;
    request.gameState.stage = 'flop';
    request.gameState.bombPot = true;
    request.gameState.boardCount = 3;
    request.gameState.dealtSeatIds = request.gameState.players.map((p) => p.seat);
    request.gameState.communityCards = ['2', '3', '4'].map((r) => card(r, 'clubs')) as any;
    request.gameState.communityCards2 = ['5', '6', '7'].map((r) => card(r, 'diamonds')) as any;
    request.gameState.communityCards3 = ['8', '9', 'T'].map((r) => card(r, 'hearts')) as any;
    return request;
  };
  it('accepts a complete physical triple-board betting snapshot', async () => {
    const h = harness();
    h.runtime.receive(rekey(multiboard()));
    await h.runtime.drain();
    expect(h.messages.at(-1)?.type).toBe('FAST_RESULT');
    expect(h.decisionsAtRng).toHaveLength(1);
  });
  it.each([
    'missing',
    'duplicate',
    'unknown',
    'omitted_live',
    'omitted_hero',
    'invalid_seat',
  ] as const)('refuses %s dealt census', async (fault) => {
    const request = multiboard();
    if (fault === 'missing') delete request.gameState.dealtSeatIds;
    if (fault === 'duplicate') request.gameState.dealtSeatIds = [2, 3, 3];
    if (fault === 'unknown') request.gameState.dealtSeatIds = [2, 3, 99];
    if (fault === 'omitted_live') request.gameState.dealtSeatIds = [2];
    if (fault === 'omitted_hero') request.gameState.dealtSeatIds = [3];
    if (fault === 'invalid_seat') {
      request.gameState.players[1].seat = 11;
      request.gameState.dealtSeatIds = [2, 11];
    }
    const h = harness();
    h.runtime.receive(rekey(request));
    await h.runtime.drain();
    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: expect.stringContaining('dealt_census'),
    });
  });
  it('counts folded disconnected cards when checking deck exhaustion', async () => {
    const request = multiboard();
    for (const seat of [1, 4, 5, 6, 7, 8, 9, 10])
      request.gameState.players.push({
        ...request.gameState.players[1],
        seat,
        user_id: `folded-${seat}`,
        is_folded: true,
        is_sitting_out: true,
        bet: 0,
        totalInvested: 0,
      });
    request.gameState.dealtSeatIds = request.gameState.players.map((p) => p.seat);
    const h = harness();
    h.runtime.receive(rekey(request));
    await h.runtime.drain();
    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: expect.stringContaining('deck_exhausted'),
    });
  });
  it.each([
    'hero_collision',
    'board_collision',
    'third_board_short',
    'declared_count',
    'invalid_rank',
    'malformed_board',
  ] as const)('refuses %s before running strategy', async (fault) => {
    const request = multiboard(),
      gs = request.gameState;
    if (fault === 'hero_collision') gs.communityCards2![0] = request.player.cards[0];
    if (fault === 'board_collision') gs.communityCards3![0] = gs.communityCards2![0];
    if (fault === 'third_board_short') gs.communityCards3!.pop();
    if (fault === 'declared_count') gs.boardCount = 2;
    if (fault === 'invalid_rank') gs.communityCards2![0].rank = 'X' as any;
    if (fault === 'malformed_board') gs.communityCards3 = {} as any;
    const h = harness();
    h.runtime.receive(rekey(request));
    await h.runtime.drain();
    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: expect.stringMatching(/joint_cards/),
    });
  });
});

function phase6TournamentRequest(requestId = 50): FastHorseDecisionRequest {
  const player = { ...snapshot.player, cards: snapshot.player.cards.slice(0, 2) };
  const m = buildTournamentMState({
    stackChips: player.stack,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0.2,
    anteType: 'big_blind',
    playersAtTable: 2,
    nextSmallBlind: 2,
    nextBigBlind: 4,
    nextAnte: 0.4,
    minutesToNextLevel: 5,
    opponentStacks: [{ userId: 'horse-3', stackChips: 96 }],
  });
  return rekey({
    ...fastRequest(requestId),
    player,
    gameState: {
      ...snapshot.gameState,
      gameVariant: 'nlh',
      gameMode: 'tournament',
      format: 'mtt',
      dealerSeat: 2,
      ante: 0.2,
      bigBlindAnte: true,
      bettingStructure: 'no_limit',
      variantRules: {
        holeCardsDealt: 2,
        holeCardsUse: 'any',
        boardCardsUse: 'any',
        deckSize: 52,
        splitLow8OrBetter: false,
      },
      tournament: {
        schemaVersion: 1,
        contextStatus: 'complete',
        contextIssues: [],
        sourceAgeMs: 100,
        tournamentId: 'phase6-tournament',
        tournamentType: 'MTT',
        tournamentStatus: 'RUNNING',
        gameVariant: 'nlh',
        entrants: 20,
        nearBubble: false,
        inMoney: false,
        playersLeft: 10,
        spotsPaid: 3,
        avgStackChips: 95,
        medianStackChips: 95,
        seatsPerTable: 2,
        playersAtTable: 2,
        currentLevel: 4,
        currentSmallBlind: 1,
        currentBigBlind: 2,
        currentAnte: 0.2,
        anteType: 'big_blind',
        nextSmallBlind: 2,
        nextBigBlind: 4,
        nextAnte: 0.4,
        levelDurationMin: 10,
        levelElapsedMin: 5,
        registrationOpen: true,
        lateRegistrationOpen: true,
        registrationRequiresAuthorization: false,
        isPko: false,
        isBounty: false,
        isMysteryBounty: false,
        reentryAllowed: false,
        reentryOpen: false,
        maxReentries: 0,
        rebuyAllowed: false,
        rebuyOpen: false,
        maxRebuys: 0,
        addOnAvailable: false,
        addOnPeriodOpen: false,
        addOnCost: null,
        addOnChips: null,
        addOnLevels: null,
        onBreak: false,
        handForHand: false,
        handForHandExpected: false,
        m,
        bountyFactor: 0,
        stacks: [100, 90],
        payoutPct: [50, 30, 20],
        mysteryChestsLeft: 0,
        mysteryMeanCents: 0,
        mysteryTopCents: 0,
        mysteryTopLive: false,
        meanBountyCents: 0,
        finalTable: false,
        nextBlindInMin: 5,
        nextBlindMult: 2,
        satellite: false,
        satelliteSeats: 0,
        bountyByUser: {},
      },
    },
  });
}

const pineappleCards = [
  { rank: 'A' as const, suit: 'spades' as const },
  { rank: 'K' as const, suit: 'spades' as const },
  { rank: 'Q' as const, suit: 'hearts' as const },
];

function pineappleRequest(
  stage: 'preflop' | 'flop' | 'pineapple_discard' | 'turn' | 'river',
  cardCount: 2 | 3,
  discardProof = stage === 'flop' || stage === 'turn' || stage === 'river',
  requestId = 1
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
    ...fastRequest(requestId),
    player: {
      ...snapshot.player,
      cards: pineappleCards.slice(0, cardCount),
      knownDeadCards: cardCount === 2 ? pineappleCards.slice(2) : [],
    },
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
  it('accepts a complete Phase 6 tournament context and canonical M snapshot', async () => {
    const h = harness();
    h.runtime.receive(phase6TournamentRequest());
    await h.runtime.drain();

    expect(h.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId: 50 });
  });

  it('accepts an explicitly labeled warming context instead of mistaking it for cash', async () => {
    const request = phase6TournamentRequest(51);
    const tournament = request.gameState.tournament!;
    const warming = rekey({
      ...request,
      gameState: {
        ...request.gameState,
        tournament: {
          ...tournament,
          contextStatus: 'warming',
          contextIssues: [TOURNAMENT_CONTEXT_INCOMPLETE, 'tournament_context_warming'],
          sourceAgeMs: null,
          tournamentId: null,
          tournamentType: '',
          tournamentStatus: '',
          gameVariant: '',
          entrants: 0,
          playersLeft: 0,
          spotsPaid: 0,
          avgStackChips: 0,
          medianStackChips: 0,
          currentLevel: 0,
          levelDurationMin: null,
          levelElapsedMin: null,
          stacks: [],
          payoutPct: [],
        },
      },
    });
    const h = harness();
    h.runtime.receive(warming);
    await h.runtime.drain();

    expect(h.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId: 51 });
  });

  it('rejects an implicit tournament context and a non-canonical M snapshot', async () => {
    const missing = phase6TournamentRequest(52);
    const h1 = harness();
    h1.runtime.receive(
      rekey({ ...missing, gameState: { ...missing.gameState, tournament: undefined } })
    );
    await h1.runtime.drain();
    expect(h1.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'Phase 6 tournament context schema version 1 is required',
    });

    const malformed = phase6TournamentRequest(53);
    const tournament = malformed.gameState.tournament!;
    const h2 = harness();
    h2.runtime.receive(
      rekey({
        ...malformed,
        gameState: {
          ...malformed.gameState,
          tournament: { ...tournament, m: { ...tournament.m!, realM: tournament.m!.realM + 1 } },
        },
      })
    );
    await h2.runtime.drain();
    expect(h2.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'Phase 6 tournament M state does not match the canonical snapshot',
    });
  });

  it('requires an explicit cash/tournament mode and forbids tournament state on cash requests', async () => {
    const missingMode = rekey({
      ...fastRequest(54),
      gameState: { ...snapshot.gameState, gameMode: undefined } as never,
    });
    const h1 = harness();
    h1.runtime.receive(missingMode);
    await h1.runtime.drain();
    expect(h1.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'horse state gameMode must be explicit',
    });

    const tournament = phase6TournamentRequest(55).gameState.tournament;
    const cashWithTournament = rekey({
      ...fastRequest(55),
      gameState: { ...snapshot.gameState, tournament },
    });
    const h2 = harness();
    h2.runtime.receive(cashWithTournament);
    await h2.runtime.drain();
    expect(h2.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'cash horse state cannot carry tournament context',
    });
  });

  it.each([
    ['nextBlindInMin', '5'],
    ['nextBlindMult', 0],
  ] as const)('rejects malformed tournament clock field %s', async (field, value) => {
    const request = phase6TournamentRequest(56);
    const tournament = request.gameState.tournament!;
    const malformed = rekey({
      ...request,
      gameState: {
        ...request.gameState,
        tournament: { ...tournament, [field]: value } as never,
      },
    });
    const h = harness();
    h.runtime.receive(malformed);
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'Phase 6 tournament context numeric state is invalid',
    });
  });

  it('rejects a non-numeric bounty and does not coerce a malformed M value', async () => {
    const request = phase6TournamentRequest(57);
    const tournament = request.gameState.tournament!;
    const badBounty = rekey({
      ...request,
      gameState: {
        ...request.gameState,
        tournament: { ...tournament, bountyByUser: { villain: '100' } } as never,
      },
    });
    const h1 = harness();
    h1.runtime.receive(badBounty);
    await h1.runtime.drain();
    expect(h1.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'Phase 6 tournament payout or bounty state is invalid',
    });

    const badM = rekey({
      ...request,
      requestId: 58,
      gameState: {
        ...request.gameState,
        tournament: {
          ...tournament,
          m: { ...tournament.m!, realM: String(tournament.m!.realM) } as never,
        },
      },
    });
    const h2 = harness();
    h2.runtime.receive(badM);
    await h2.runtime.drain();
    expect(h2.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'Phase 6 tournament M state does not match the canonical snapshot',
    });
  });

  it('accepts canonical covering opponents independent of array order', async () => {
    const request = phase6TournamentRequest(59);
    const third = {
      seat: 4,
      user_id: 'horse-4',
      username: 'Horse Four',
      stack: 120,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    };
    const players = [...request.gameState.players, third];
    const tournament = request.gameState.tournament!;
    const m = buildTournamentMState({
      stackChips: request.player.stack,
      smallBlind: tournament.currentSmallBlind!,
      bigBlind: tournament.currentBigBlind!,
      ante: tournament.currentAnte!,
      anteType: tournament.anteType!,
      playersAtTable: 3,
      nextSmallBlind: tournament.nextSmallBlind,
      nextBigBlind: tournament.nextBigBlind,
      nextAnte: tournament.nextAnte,
      minutesToNextLevel: tournament.nextBlindInMin,
      opponentStacks: players
        .filter((seat) => seat.user_id !== request.player.user_id)
        .map((seat) => ({ userId: seat.user_id, stackChips: seat.stack })),
    });
    const reordered = rekey({
      ...request,
      gameState: {
        ...request.gameState,
        players,
        tournament: {
          ...tournament,
          seatsPerTable: 3,
          playersAtTable: 3,
          stacks: [120, 96, 88],
          m: { ...m, coveringOpponents: [...m.coveringOpponents].reverse() },
        },
      },
    });
    const h = harness();
    h.runtime.receive(reordered);
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId: 59 });
  });

  it('counts a tournament sit-out in orbit M while excluding it from covering pressure', async () => {
    const request = phase6TournamentRequest(60);
    const sitOut = {
      seat: 4,
      user_id: 'horse-4',
      username: 'Horse Four',
      stack: 120,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: true,
    };
    const players = [...request.gameState.players, sitOut];
    const tournament = request.gameState.tournament!;
    const m = buildTournamentMState({
      stackChips: request.player.stack,
      smallBlind: tournament.currentSmallBlind!,
      bigBlind: tournament.currentBigBlind!,
      ante: tournament.currentAnte!,
      anteType: tournament.anteType!,
      playersAtTable: 3,
      nextSmallBlind: tournament.nextSmallBlind,
      nextBigBlind: tournament.nextBigBlind,
      nextAnte: tournament.nextAnte,
      minutesToNextLevel: tournament.nextBlindInMin,
      opponentStacks: request.gameState.players
        .filter((seat) => seat.user_id !== request.player.user_id)
        .map((seat) => ({ userId: seat.user_id, stackChips: seat.stack })),
    });
    const dealtSitOut = rekey({
      ...request,
      gameState: {
        ...request.gameState,
        dealerSeat: sitOut.seat,
        players,
        tournament: {
          ...tournament,
          seatsPerTable: 3,
          playersAtTable: 3,
          stacks: [120, 96, 88],
          m,
        },
      },
    });
    const h = harness();
    h.runtime.receive(dealtSitOut);
    await h.runtime.drain();

    expect(m.coveringOpponents.map((opponent) => opponent.userId)).toEqual(['horse-3']);
    expect(h.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId: 60 });
  });

  it('accepts a per-player ante that begins at the next blind level', async () => {
    const request = phase6TournamentRequest(61);
    const tournament = request.gameState.tournament!;
    const m = buildTournamentMState({
      stackChips: request.player.stack,
      smallBlind: tournament.currentSmallBlind!,
      bigBlind: tournament.currentBigBlind!,
      ante: 0,
      anteType: 'per_player',
      playersAtTable: 2,
      nextSmallBlind: tournament.nextSmallBlind,
      nextBigBlind: tournament.nextBigBlind,
      nextAnte: 0.4,
      minutesToNextLevel: tournament.nextBlindInMin,
      opponentStacks: request.gameState.players
        .filter((seat) => seat.user_id !== request.player.user_id)
        .map((seat) => ({ userId: seat.user_id, stackChips: seat.stack })),
    });
    const anteStartsNextLevel = rekey({
      ...request,
      gameState: {
        ...request.gameState,
        ante: 0,
        bigBlindAnte: false,
        tournament: {
          ...tournament,
          currentAnte: 0,
          anteType: 'per_player',
          nextAnte: 0.4,
          m,
        },
      },
    });
    const h = harness();
    h.runtime.receive(anteStartsNextLevel);
    await h.runtime.drain();

    expect(h.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId: 61 });
  });

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
      recoverable: true,
    });
  });

  it('continues its real FIFO after isolating an invalid Pineapple snapshot', async () => {
    const h = harness();
    h.runtime.receive(pineappleRequest('flop', 3, true, 1));
    h.runtime.receive(fastRequest(2));
    await h.runtime.drain();

    expect(h.decisionsAtRng).toHaveLength(1);
    expect(h.messages.slice(-2)).toMatchObject([
      {
        type: 'ERROR',
        requestId: 1,
        recoverable: true,
        message: 'horse state hero card count does not match variant/street rules',
      },
      { type: 'FAST_RESULT', requestId: 2 },
    ]);
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

  it.each([
    'missing',
    'malformed',
    'hero_collision',
    'board_collision',
    'other_variant',
    'public_leak',
  ])('rejects %s known-discard inputs before invoking any decision computation', async (fault) => {
    const h = harness();
    const request = fault === 'other_variant' ? fastRequest(1) : pineappleRequest('flop', 2);
    request.player = { ...request.player };
    if (fault === 'missing') delete request.player.knownDeadCards;
    if (fault === 'malformed') request.player.knownDeadCards = {} as any;
    if (fault === 'hero_collision') request.player.knownDeadCards = [request.player.cards[0]];
    if (fault === 'board_collision')
      request.player.knownDeadCards = [request.gameState.communityCards[0]];
    if (fault === 'other_variant') request.player.knownDeadCards = [pineappleCards[0]];
    if (fault === 'public_leak')
      request.gameState.players = request.gameState.players.map((seat, i) =>
        i === 0 ? { ...seat, knownDeadCards: [pineappleCards[2]] } : seat
      );
    h.runtime.receive(rekey(request));
    await h.runtime.drain();
    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      recoverable: true,
      message:
        fault === 'public_leak'
          ? 'horse state contains private seat cards'
          : 'horse state known discard or physical cards are invalid',
    });
  });

  it("binds the hero's private discarded card into the decision key", async () => {
    const h = harness();
    const request = pineappleRequest('flop', 2);
    request.player.knownDeadCards = [{ rank: '3', suit: 'clubs' }];
    h.runtime.receive(request);
    await h.runtime.drain();
    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'decisionKey does not bind the canonical decision snapshot',
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

  it.each([
    { gtoV31DatasetChecksum: 'a'.repeat(64) },
    { phase8Postflop: 'candidate' },
    { phase10Plo4: 'candidate' },
    { phase10EvidenceMode: true },
    { phase11Omaha: 'candidate' },
    { phase11EvidenceMode: true },
    { phase12Remaining: 'candidate' },
    { phase12EvidenceMode: true },
    { phase13Joint: 'candidate' },
    { phase13EvidenceMode: true },
    { phase13EvidenceMode: false },
  ])('rejects offline candidate selectors at the live worker boundary: %j', async (opts) => {
    const h = harness();
    h.runtime.receive({
      ...fastRequest(),
      opts,
    } as unknown as FastHorseDecisionRequest);
    await h.runtime.drain();

    expect(h.decisionOpts).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      requestId: 1,
      generation: 4,
      fence: 'table:hand:turn',
      message: 'offline candidate controls are forbidden in live decision requests',
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
    expect(h.messages.at(-1)).not.toHaveProperty('recoverable');
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
      communityCards: [
        { rank: '7', suit: 'hearts' },
        { rank: '8', suit: 'hearts' },
        { rank: '3', suit: 'clubs' },
      ],
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

  it.each([
    'missing_flop',
    'future_board',
    'wrong_variant',
    'duplicate_hole',
    'board_collision',
    'invalid_card',
  ])('rejects an invalid discard snapshot before computation: %s', async (fault) => {
    const h = harness();
    const request = {
      type: 'DECIDE_DISCARD' as const,
      requestId: 1,
      generation: 4,
      fence: 'table:hand:discard:2',
      cards: structuredClone(pineappleCards),
      communityCards: [
        { rank: '7', suit: 'hearts' },
        { rank: '8', suit: 'hearts' },
        { rank: '3', suit: 'clubs' },
      ] as typeof snapshot.player.cards,
      gameVariant: 'pineapple',
    };
    if (fault === 'missing_flop') request.communityCards = [];
    if (fault === 'future_board') request.communityCards.push({ rank: '4', suit: 'clubs' });
    if (fault === 'wrong_variant') request.gameVariant = 'short_deck';
    if (fault === 'duplicate_hole') request.cards[1] = request.cards[0];
    if (fault === 'board_collision') request.communityCards[0] = request.cards[0];
    if (fault === 'invalid_card') request.cards[0] = null as unknown as (typeof request.cards)[0];
    h.runtime.receive(request);
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({ type: 'ERROR', requestId: 1 });
    expect(h.decisionsAtRng).toEqual([]);
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

  it('binds historical review evidence without letting it choose the policy RNG stream', async () => {
    const clean = rekey({ ...fastRequest(), mods: { aggression: 1.1 } });
    const observed = rekey({
      ...clean,
      mods: {
        ...clean.mods,
        leaks: { coldcall_stackoff: 50 },
        leaksHands: 100,
        leaksHoldem: { river_raise_war: 20 },
        leaksHandsHoldem: 100,
        leaksOmaha: { plo_naked_trips_stackoff: 30 },
        leaksHandsOmaha: 100,
        leaksTournament: { preflop_stackoff: 40 },
        leaksHandsTournament: 100,
      },
    });
    expect(observed.decisionKey).not.toBe(clean.decisionKey);
    const a = harness();
    const b = harness();
    a.runtime.receive(clean);
    b.runtime.receive(observed);
    await Promise.all([a.runtime.drain(), b.runtime.drain()]);
    expect(a.decisionsAtRng).toHaveLength(1);
    expect(b.decisionsAtRng).toEqual(a.decisionsAtRng);

    const tampered = harness();
    tampered.runtime.receive({ ...observed, decisionKey: clean.decisionKey });
    await tampered.runtime.drain();
    expect(tampered.decisionsAtRng).toEqual([]);
    expect(tampered.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'decisionKey does not bind the canonical decision snapshot',
    });
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

  it.each(HORSE_REVIEW_SIGNAL_KEYS)(
    'excludes only diagnostic %s from sampling, retaining full validation',
    (key) => {
      const clean = rekey({ ...fastRequest(), mods: { aggression: 1.1 } });
      const observed = rekey({
        ...clean,
        mods: { ...clean.mods, [key]: key.includes('Hands') ? 100 : { coldcall_stackoff: 40 } },
      });
      expect(observed.decisionKey).not.toBe(clean.decisionKey);
      expect(validatedHorsePolicySamplingKey(observed)).toBe(
        validatedHorsePolicySamplingKey(clean)
      );
    }
  );

  it('normalizes empty bags and diagnostic options while preserving authored inputs', () => {
    const clean = rekey({ ...fastRequest(), mods: undefined, opts: undefined });
    const key = validatedHorsePolicySamplingKey(clean);
    for (const mods of [undefined, {}, { leaks: {} }, { leaksHands: 0 }, { leaks: undefined }]) {
      for (const opts of [undefined, {}, { v41Leaks: true }, { v41Leaks: false }]) {
        expect(validatedHorsePolicySamplingKey(rekey({ ...clean, mods, opts }))).toBe(key);
      }
    }
    for (const mods of [
      { aggression: 1.2 },
      { tightness: 1.1 },
      { sizingMultiplier: 0.9 },
      { bluffFreq: 1.1 },
    ]) {
      expect(validatedHorsePolicySamplingKey(rekey({ ...clean, mods }))).not.toBe(key);
    }
    expect(
      validatedHorsePolicySamplingKey(rekey({ ...clean, opts: { v40Omaha: false } }))
    ).not.toBe(key);
    // Invalid diagnostics are still rejected by the full canonicalizer.
    expect(() => rekey({ ...clean, mods: { leaksHands: Number.NaN } })).toThrow('non-finite');
  });

  it('replays the projected seed for a deep decision and restores the canonical stream', async () => {
    const h = harness();
    const request = rekey({
      ...fastRequest(),
      mods: { leaksHands: 100 },
      opts: { v41Leaks: false },
    });
    h.runtime.receive(request);
    await h.runtime.drain();
    const fast = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (fast?.type !== 'FAST_RESULT') throw new Error('fast decision missing');
    h.runtime.receive({
      ...request,
      type: 'DECIDE_DEEP',
      requestId: 2,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({ type: 'DEEP_RESULT' });
    expect(h.decisionsAtRng).toEqual([fast.rngBefore, fast.rngBefore]);
    expect(h.rng()).toBe(101);
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
    expect(h.messages.at(-1)).not.toHaveProperty('recoverable');
  });

  it('starts each posted job on its own event-loop turn, so a CANCEL between them is honoured', async () => {
    const h = harness();
    h.runtime.receive(fastRequest(1));
    h.runtime.receive(fastRequest(2));
    // A later port message arrives on a later macrotask. Before 2026-09-11 both
    // jobs ran back to back in microtasks and this CANCEL found nothing pending.
    setImmediate(() => h.runtime.receive({ type: 'CANCEL', requestId: 2 }));
    await h.runtime.drain();

    expect(h.messages.map((message) => message.type)).toEqual([
      'READY',
      'FAST_RESULT',
      'CANCELLED',
    ]);
    expect(h.messages[1]).toMatchObject({ requestId: 1 });
    expect(h.messages[2]).toMatchObject({ requestId: 2 });
    expect(h.decisionsAtRng).toHaveLength(1);
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

it('Phase 10 real PLO4 policy receipt survives the canonical live worker boundary', async () => {
  const h = harness(true);
  const request = {
    type: 'DECIDE_FAST' as const,
    requestId: 432,
    ...structuredClone(snapshot),
    style: 'balanced' as const,
    mods: {},
    opts: { mind: false, telemetry: false },
  };
  request.gameState.dealerSeat = 2;
  request.decisionKey = buildHorseDecisionKey(request);
  h.runtime.receive(request);
  await h.runtime.drain();
  const result = h.messages.find((m) => m.type === 'FAST_RESULT');
  if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(h.messages));
  expect(result.decision.plo4Policy?.mode).toBe('shadow');
  expect(result.decision.plo4Policy?.eligible).toBe(true);
  expect(result.decision.plo4Policy?.fired).toBe(true);
  expect(structuredClone(result).decision.plo4Policy?.finalAction).toBe(result.decision.action);
});

it.each(['plo5', 'plo6', 'plo8'] as const)(
  'Phase 11 %s receipt survives the live worker boundary',
  async (variant) => {
    // This fixture proves the real policy receipt reaches the worker result.
    // Keep its compute clock deterministic under parallel test load. Dedicated
    // policy-budget tests and the actual-controller benchmark retain time limits.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const { omahaVariantSpot } = await import('../../benchmark/OmahaVariantPolicyEvidence.js');
      const h = harness(true);
      const input = omahaVariantSpot(variant, 'preflop');
      const request = {
        type: 'DECIDE_FAST' as const,
        requestId: 511,
        ...structuredClone(snapshot),
        style: 'balanced' as const,
        mods: {},
        opts: { mind: false, telemetry: false },
        player: input.hero,
        gameState: input.state,
      };
      request.decisionKey = buildHorseDecisionKey(request);
      h.runtime.receive(request);
      await h.runtime.drain();
      const result = h.messages.find((m) => m.type === 'FAST_RESULT');
      if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(h.messages));
      expect(result.decision.omahaVariantPolicy?.mode).toBe('shadow');
      expect(result.decision.omahaVariantPolicy?.eligible).toBe(true);
      expect(result.decision.omahaVariantPolicy?.fired).toBe(true);
      expect(structuredClone(result).decision.omahaVariantPolicy?.finalAction).toBe(
        result.decision.action
      );
    } finally {
      clock.mockRestore();
    }
  }
);

it.each(['short_deck', 'pineapple', 'flh', 'flo8'] as const)(
  'Phase 12 %s receipt survives the live worker boundary',
  async (variant) => {
    const { remainingVariantSpot } =
      await import('../../benchmark/RemainingVariantPolicyEvidence.js');
    const h = harness(true);
    const input = remainingVariantSpot(variant, 'preflop');
    const request = {
      type: 'DECIDE_FAST' as const,
      requestId: 512,
      ...structuredClone(snapshot),
      style: 'balanced' as const,
      mods: {},
      opts: { mind: false, telemetry: false },
      player: input.hero,
      gameState: input.state,
    };
    request.decisionKey = buildHorseDecisionKey(request);
    h.runtime.receive(request);
    await h.runtime.drain();
    const result = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(h.messages));
    expect(result.decision.remainingVariantPolicy?.mode).toBe('shadow');
    expect(result.decision.remainingVariantPolicy?.eligible).toBe(true);
    expect(result.decision.remainingVariantPolicy?.fired).toBe(true);
    expect(structuredClone(result).decision.remainingVariantPolicy?.finalAction).toBe(
      result.decision.action
    );
  }
);
