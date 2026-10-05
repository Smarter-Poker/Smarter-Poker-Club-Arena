import { withPhase6Provenance } from '../../testing/horseRegression/merged/fixture.js';
import { horsePlanBatchBindingFromRequest } from '../HorsePlanHandIdentity.js';
import { HorseLogic } from '../HorseLogic.js';
import { HorseMind } from '../HorseMind.js';
import { jointPolicyFixture } from '../multiway/JointRangeFixture.test-support.js';
import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';

import type { HorseDecideOpts } from '../HorseLogic.js';
import type { HorseMindDecisionEffect } from '../HorseMind.js';
import type { Card } from '../../types.js';
import type {
  FastHorseDecisionRequest,
  HorseDecisionWorkerReady,
  HorseDecisionWorkerResponse,
  LiveHorseDecisionSnapshot,
} from './protocol.js';
import { buildHorseDecisionKey, validatedHorsePolicySamplingKey } from './protocol.js';
import { horseDecisionReceiptIsValid } from './responseValidation.js';
import * as plo4Live from '../plo4/Plo4LivePolicy.js';
import { omahaVariantReceiptBindingIsValid } from '../omaha/OmahaVariantLivePolicy.js';
import { remainingVariantReceiptBindingIsValid } from '../remainingVariants/RemainingVariantLivePolicy.js';
import { HORSE_REVIEW_SIGNAL_KEYS } from '../HorseReviewSignals.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from './workerRuntime.js';
import {
  buildTournamentMState,
  TOURNAMENT_ANTE_TYPES,
  TOURNAMENT_CONTEXT_INCOMPLETE,
  TOURNAMENT_CONTEXT_STATUSES,
  TOURNAMENT_PREFLOP_ATLAS_DOMAIN,
} from '../HorseTournamentPreflop.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import type { HorseDiscardExecutionObservation } from '../../services/horseDecisionJournal/discard.js';
import type { HorseAuthorityAdmission } from '../HorseQualifiedAuthority.js';
import { qualifiedTestAdmission } from '../HorseQualifiedAuthority.test-support.js';
import { memoryReader } from '../HorseQualifiedAuthority.test-support.js';
import {
  admitHorsePhase10QualifiedAuthority,
  admitHorsePhase10ReleaseAuthority,
} from '../HorsePhase10Authority.js';
import {
  P10_TEST_CONTRACT_DIGEST,
  P10_TEST_NOW,
  p10QualificationBytes,
  p10Reader,
  p10Selection,
  qualifiedPhase10TestAdmission,
} from '../HorsePhase10Authority.test-support.js';
import { plo4Cards } from '../../benchmark/Plo4PolicyEvidence.js';
import { variantCards } from '../../benchmark/OmahaVariantPolicyEvidence.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import {
  admitHorsePhase11QualifiedAuthority,
  admitHorsePhase11ReleaseAuthority,
} from '../HorsePhase11Authority.js';
import {
  P11_TEST_CONTRACT_DIGEST,
  P11_TEST_NOW,
  p11CompletionBytes,
  p11CompletionObject,
  p11QualificationBytes,
  p11Reader,
  p11Selection,
  p11Street,
  qualifiedPhase11TestAdmission,
} from '../HorsePhase11Authority.test-support.js';
import { OMAHA_VARIANT_PACKS, type OmahaPolicyVariant } from '../omaha/OmahaVariantPolicyPack.js';
import { restoreFastRandom, saveFastRandom, seedFastRandom } from '../HorseEval.js';
import {
  admitHorsePhase12QualifiedAuthority,
  admitHorsePhase12ReleaseAuthority,
} from '../HorsePhase12Authority.js';
import {
  P12_TEST_CONTRACT_DIGEST,
  P12_TEST_NOW,
  p12CompletionBytes,
  p12CompletionObject,
  p12QualificationBytes,
  p12Reader,
  p12Selection,
  p12Street,
  qualifiedPhase12TestAdmission,
} from '../HorsePhase12Authority.test-support.js';
import {
  REMAINING_VARIANT_PACKS,
  type RemainingPolicyVariant,
} from '../remainingVariants/RemainingVariantPolicyPack.js';

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
  let stopFailure: Error | null = null;
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
      if (stopFailure) throw stopFailure;
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
    deps,
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
    setStopFailure: (error: Error) => {
      stopFailure = error;
    },
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
    advanceClock: (ms: number) => {
      now += ms;
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
  it.each(['PLO4', 'Plo4'])(
    'rejects noncanonical policy name %s before invoking the brain',
    async (variant) => {
      const h = harness();
      const request = structuredClone(fastRequest());
      request.gameState.gameVariant = variant as any;
      h.runtime.receive(rekey(request));
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('ERROR');
      expect(h.decisionsAtRng).toHaveLength(0);
    }
  );
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
  it('binds source provenance while preserving the real worker policy sampling stream', async () => {
    const clean = rekey({ ...phase6TournamentRequest(), fence: 'table-a:12:2:9:4' });
    const observed = rekey(withPhase6Provenance(clean));
    expect(observed.decisionKey).not.toBe(clean.decisionKey);
    expect(validatedHorsePolicySamplingKey(observed)).toBe(validatedHorsePolicySamplingKey(clean));
    const a = harness(),
      b = harness(),
      tampered = harness();
    a.runtime.receive(clean);
    b.runtime.receive(observed);
    tampered.runtime.receive({ ...observed, decisionKey: clean.decisionKey });
    await Promise.all([a.runtime.drain(), b.runtime.drain(), tampered.runtime.drain()]);
    expect(b.messages.at(-1)?.type).toBe('FAST_RESULT');
    expect(b.decisionsAtRng).toEqual(a.decisionsAtRng);
    expect(b.decisionsAtRng).toHaveLength(1);
    expect(tampered.decisionsAtRng).toEqual([]);
    expect(tampered.messages.at(-1)?.type).toBe('ERROR');
    const changed = structuredClone(observed);
    changed.gameState.tournament!.contextProvenance!.source!.generation++;
    expect(validatedHorsePolicySamplingKey(rekey(changed))).toBe(
      validatedHorsePolicySamplingKey(clean)
    );
    changed.gameState.tournament!.sourceAgeMs!++;
    expect(validatedHorsePolicySamplingKey(rekey(changed))).not.toBe(
      validatedHorsePolicySamplingKey(clean)
    );
  });

  it.each([
    'tournament',
    'table',
    'hand',
    'actor',
    'blinds',
    'dealer',
    'seats',
    'age',
    'generation',
    'digest',
    'status',
    'local_status',
  ])('refuses mismatched Phase 6 %s provenance before calling the policy', async (fault) => {
    const r = withPhase6Provenance({ ...phase6TournamentRequest(), fence: 'table-a:12:2:9:4' });
    const p = r.gameState.tournament!.contextProvenance!;
    if (fault === 'tournament') p.source!.tournamentId = 'other';
    if (fault === 'table') p.projection.tableId = 'table-b';
    if (fault === 'hand') p.projection.handNumber++;
    if (fault === 'actor') p.projection.actorId = 'another-horse';
    if (fault === 'blinds') p.projection.bigBlind++;
    if (fault === 'dealer') p.projection.dealerSeat = 9;
    if (fault === 'seats') p.projection.dealtSeatIds.reverse();
    if (fault === 'age') p.ageMs!++;
    if (fault === 'generation') p.source!.generation = 0;
    if (fault === 'digest') p.source!.contextDigest = 'unverified';
    if (fault === 'status') p.status = 'warming';
    if (fault === 'local_status') {
      r.gameState.tournament!.contextStatus = 'stale';
      r.gameState.tournament!.contextIssues = [
        TOURNAMENT_CONTEXT_INCOMPLETE,
        'tournament_context_stale',
      ];
    }
    const h = harness();
    h.runtime.receive(rekey(r));
    await h.runtime.drain();
    expect(h.decisionsAtRng).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: expect.stringMatching(/provenance/),
    });
  });

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

  /** Phase 6B: a labeled non-complete context keeps the complete request's numeric facts. */
  function labeledContextRequest(
    contextStatus: 'incomplete' | 'warming' | 'stale',
    requestId: number
  ): FastHorseDecisionRequest {
    const request = phase6TournamentRequest(requestId);
    const tournament = request.gameState.tournament!;
    return rekey({
      ...request,
      gameState: {
        ...request.gameState,
        tournament: {
          ...tournament,
          contextStatus,
          contextIssues: [TOURNAMENT_CONTEXT_INCOMPLETE, `tournament_context_${contextStatus}`],
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
  }

  it.each(['incomplete', 'warming', 'stale'] as const)(
    'Phase 6B: routes a real %s-context decision through the atlas as incomplete_context with zero shifts',
    async (contextStatus) => {
      const h = harness(true);
      h.runtime.receive(labeledContextRequest(contextStatus, 70));
      await h.runtime.drain();
      const result = h.messages.at(-1);
      if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(result));
      expect(result.requestId).toBe(70);
      const receipt = result.decision.tournamentPreflopAttribution!;
      expect(receipt.reason).toBe('incomplete_context');
      expect(receipt.status).toBe('unavailable');
      expect(receipt.lookup!.coordinate.gameFamily).toBe('nlh');
      expect(receipt.lookup!.coordinate.contextStatus).toBe(contextStatus);
      expect(receipt.lookup!.policy.source).toBe('labeled_fallback');
      expect(receipt.lookup!.policy.fallbackReason).toBe('incomplete_context');
      expect(Object.values(receipt.lookup!.policy.shifts)).toEqual([0, 0, 0, 0, 0]);
    }
  );

  it('Phase 6B: the complete control on the same request reaches the atlas baseline', async () => {
    const h = harness(true);
    h.runtime.receive(phase6TournamentRequest(71));
    await h.runtime.drain();
    const result = h.messages.at(-1);
    if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(result));
    const receipt = result.decision.tournamentPreflopAttribution!;
    expect(receipt.reason).toBe('atlas_forwarded');
    expect(receipt.status).toBe('atlas_evaluated');
    expect(receipt.lookup!.policy.source).toBe('deterministic_baseline');
  });

  it('Phase 6B: refuses a complete dead-button coordinate and keeps its named fallback usable', async () => {
    const request = phase6TournamentRequest(73);
    const tournament = request.gameState.tournament!;
    const players = [
      ...request.gameState.players,
      {
        ...request.gameState.players[1],
        seat: 4,
        user_id: 'horse-4',
        username: 'Horse Four',
        stack: 500,
        bet: 0,
        totalInvested: 0,
        is_folded: true,
        is_sitting_out: true,
      },
    ];
    const withContext = (complete: boolean) =>
      rekey({
        ...request,
        gameState: {
          ...request.gameState,
          dealerSeat: 1,
          players,
          tournament: {
            ...tournament,
            seatsPerTable: 3,
            playersAtTable: 3,
            contextStatus: complete ? 'complete' : 'incomplete',
            contextIssues: complete
              ? []
              : [TOURNAMENT_CONTEXT_INCOMPLETE, 'dead_button_atlas_unsupported'],
            m: buildTournamentMState({
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
              opponentStacks: [{ userId: 'horse-3', stackChips: 96 }],
            }),
          },
        },
      });
    const refused = harness();
    refused.runtime.receive(withContext(true));
    await refused.runtime.drain();
    expect(refused.decisionsAtRng).toEqual([]);
    expect(refused.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'Phase 6 complete tournament context has dead_button_atlas_unsupported',
    });
    const fallback = harness(true);
    fallback.runtime.receive(withContext(false));
    await fallback.runtime.drain();
    const result = fallback.messages.at(-1);
    if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(result));
    expect(result.decision.tournamentPreflopAttribution).toMatchObject({
      reason: 'incomplete_context',
      status: 'unavailable',
      lookup: { policy: { source: 'labeled_fallback', fallbackReason: 'incomplete_context' } },
    });
    expect(
      Object.values(result.decision.tournamentPreflopAttribution!.lookup!.policy.shifts)
    ).toEqual([0, 0, 0, 0, 0]);
  });

  it('Phase 6B: a dealt sit-out counts in the census but never as a covering stack', async () => {
    const request = phase6TournamentRequest(72);
    const sitOut = {
      ...request.gameState.players[1],
      seat: 4,
      user_id: 'horse-4',
      username: 'Horse Four',
      stack: 500,
      bet: 0,
      totalInvested: 0,
      is_folded: true,
      is_sitting_out: true,
    };
    const players = [...request.gameState.players, sitOut];
    const tournament = request.gameState.tournament!;
    const mFor = (opponents: Array<{ userId: string; stackChips: number }>) =>
      buildTournamentMState({
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
        opponentStacks: opponents,
      });
    const withRequest = (m: ReturnType<typeof buildTournamentMState>) =>
      rekey({
        ...request,
        gameState: {
          ...request.gameState,
          players,
          tournament: { ...tournament, seatsPerTable: 3, playersAtTable: 3, m },
        },
      });

    // Three dealt seats scale effective M by 0.3; only the actionable opponent can cover.
    const canonical = mFor([{ userId: 'horse-3', stackChips: 96 }]);
    expect(canonical.effectiveM).toBeCloseTo(canonical.realM * 0.3, 10);
    expect(canonical.coveringOpponents.map((opponent) => opponent.userId)).toEqual(['horse-3']);
    const accepted = harness(true);
    accepted.runtime.receive(withRequest(canonical));
    await accepted.runtime.drain();
    expect(accepted.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId: 72 });

    // Listing the sit-out's 500 chips as cover is not the canonical M and is refused.
    const inflated = mFor([
      { userId: 'horse-3', stackChips: 96 },
      { userId: 'horse-4', stackChips: 500 },
    ]);
    expect(inflated.coveringOpponents.map((opponent) => opponent.userId)).toEqual([
      'horse-3',
      'horse-4',
    ]);
    const refused = harness();
    refused.runtime.receive(withRequest(inflated));
    await refused.runtime.drain();
    expect(refused.decisionsAtRng).toEqual([]);
    expect(refused.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'Phase 6 tournament M state does not match the canonical snapshot',
    });
  });

  it('Phase 6B: an Omaha tournament request takes the named unsupported_variant fallback', async () => {
    const request = phase6TournamentRequest(73);
    const tournament = request.gameState.tournament!;
    const omaha = rekey({
      ...request,
      player: { ...snapshot.player },
      gameState: {
        ...request.gameState,
        gameVariant: 'plo4',
        bettingStructure: 'pot_limit',
        variantRules: snapshot.gameState.variantRules,
        legalActions: snapshot.gameState.legalActions,
        minRaiseTo: snapshot.gameState.minRaiseTo,
        maxRaiseTo: snapshot.gameState.maxRaiseTo,
        tournament: { ...tournament, gameVariant: 'plo4' },
      },
    });
    const h = harness(true);
    h.runtime.receive(omaha);
    await h.runtime.drain();
    const result = h.messages.at(-1);
    if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(result));
    const receipt = result.decision.tournamentPreflopAttribution!;
    expect(receipt.reason).toBe('unsupported_variant');
    expect(receipt.status).toBe('unavailable');
    expect(receipt.lookup!.coordinate.gameFamily).toBe('omaha');
    expect(receipt.lookup!.policy.source).toBe('labeled_fallback');
    expect(Object.values(receipt.lookup!.policy.shifts)).toEqual([0, 0, 0, 0, 0]);
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

  it('Phase 6B: the worker admits exactly the atlas domain context statuses and refuses one outside it by name', async () => {
    // The worker reads TOURNAMENT_CONTEXT_STATUSES; this pins that the admitted set is the
    // domain's set, not a second table. Every status in the domain is admitted through the
    // real validator; a status outside it is refused with the named error.
    expect([...TOURNAMENT_CONTEXT_STATUSES].sort()).toEqual(
      [
        ...TOURNAMENT_PREFLOP_ATLAS_DOMAIN.contextStatuses.baseline,
        ...TOURNAMENT_PREFLOP_ATLAS_DOMAIN.contextStatuses.fallback,
      ].sort()
    );
    let requestId = 62;
    for (const status of TOURNAMENT_CONTEXT_STATUSES) {
      const h = harness();
      h.runtime.receive(
        status === 'complete'
          ? phase6TournamentRequest(requestId)
          : labeledContextRequest(status, requestId)
      );
      await h.runtime.drain();
      expect(h.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId });
      requestId++;
    }
    const outside = labeledContextRequest('warming', requestId);
    const refused = rekey({
      ...outside,
      gameState: {
        ...outside.gameState,
        tournament: { ...outside.gameState.tournament!, contextStatus: 'pending' as never },
      },
    });
    const h = harness();
    h.runtime.receive(refused);
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'Phase 6 tournament context status is invalid',
    });
  });

  it('Phase 6B: the worker admits exactly the atlas domain ante types and refuses one outside it by name', async () => {
    expect([...TOURNAMENT_ANTE_TYPES]).toEqual([...TOURNAMENT_PREFLOP_ATLAS_DOMAIN.anteTypes]);
    const request = phase6TournamentRequest(66);
    const tournament = request.gameState.tournament!;
    const withAnte = (
      anteType: (typeof TOURNAMENT_ANTE_TYPES)[number] | 'button',
      requestId: number
    ) => {
      const ante = anteType === 'none' ? 0 : 0.4;
      const m = buildTournamentMState({
        stackChips: request.player.stack,
        smallBlind: tournament.currentSmallBlind!,
        bigBlind: tournament.currentBigBlind!,
        ante,
        anteType: anteType as never,
        playersAtTable: 2,
        nextSmallBlind: tournament.nextSmallBlind,
        nextBigBlind: tournament.nextBigBlind,
        nextAnte: ante,
        minutesToNextLevel: tournament.nextBlindInMin,
        opponentStacks: request.gameState.players
          .filter((seat) => seat.user_id !== request.player.user_id)
          .map((seat) => ({ userId: seat.user_id, stackChips: seat.stack })),
      });
      return rekey({
        ...request,
        requestId,
        gameState: {
          ...request.gameState,
          ante,
          bigBlindAnte: anteType === 'big_blind',
          tournament: {
            ...tournament,
            currentAnte: ante,
            anteType: anteType as never,
            nextAnte: ante,
            m,
          },
        },
      });
    };
    let requestId = 66;
    for (const anteType of TOURNAMENT_ANTE_TYPES) {
      const h = harness();
      h.runtime.receive(withAnte(anteType, requestId));
      await h.runtime.drain();
      expect(h.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId });
      requestId++;
    }
    const h = harness();
    h.runtime.receive(withAnte('button', requestId));
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'Phase 6 tournament context numeric state is invalid',
    });
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
    expect(h.features).toEqual(['phase5_canonical_state', 'phase15_plan_issue_no_effects']);
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

  it.each([
    ['absent, as on a snapshot older than the field', undefined],
    ['null, a hand that posted no blinds', null],
    ['the heads-up button posting the small blind', { smallBlind: 2, bigBlind: 3 }],
    ['a dead small blind', { smallBlind: null, bigBlind: 3 }],
  ])('accepts posted blind seats %s', async (_label, blindSeats) => {
    const h = harness();
    const request = structuredClone(fastRequest());
    if (blindSeats === undefined) delete request.gameState.blindSeats;
    else request.gameState.blindSeats = blindSeats;
    h.runtime.receive(rekey(request));
    await h.runtime.drain();
    expect(h.messages.at(-1)?.type).toBe('FAST_RESULT');
    expect(h.decisionsAtRng).toHaveLength(1);
  });

  it.each([
    ['an unseated big blind', { smallBlind: 2, bigBlind: 7 }],
    ['an unseated small blind', { smallBlind: 9, bigBlind: 3 }],
    ['one seat posting both blinds', { smallBlind: 3, bigBlind: 3 }],
    ['a fractional seat', { smallBlind: 2, bigBlind: 2.5 }],
    ['no small blind field', { bigBlind: 3 }],
    ['an extra field', { smallBlind: 2, bigBlind: 3, button: 2 }],
    ['an array', [2, 3]],
    ['a string', '2,3'],
  ])(
    'rejects posted blind seats with %s before HorseLogic reads them',
    async (_label, blindSeats) => {
      const h = harness();
      const request = structuredClone(fastRequest());
      request.gameState.blindSeats = blindSeats as any;
      h.runtime.receive(rekey(request));
      await h.runtime.drain();
      expect(h.decisionsAtRng).toEqual([]);
      expect(h.messages.at(-1)).toMatchObject({
        type: 'ERROR',
        message: 'horse state blind seats must be public seats',
      });
    }
  );

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

  it('retains the valid fast decision when read-frame capture fails and refuses its second look', async () => {
    const h = harness();
    const spy = vi.spyOn(HorseMind, 'snapshotDecisionReads').mockImplementationOnce(() => {
      throw Error('capture refused');
    });
    try {
      const request = fastRequest(1);
      h.runtime.receive(request);
      await h.runtime.drain();
      const fast = h.messages.find((m) => m.type === 'FAST_RESULT');
      expect(fast?.type).toBe('FAST_RESULT');
      if (fast?.type !== 'FAST_RESULT') throw Error('missing fast');
      h.runtime.receive({
        ...request,
        type: 'DECIDE_DEEP',
        requestId: 2,
        rngBefore: fast.rngBefore,
        deepEquity: 2,
      });
      await h.runtime.drain();
      expect(h.messages.at(-1)).toMatchObject({
        type: 'ERROR',
        recoverable: true,
        message: 'second look original opponent reads unavailable',
      });
      expect(h.decisionsAtRng).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([false, true])(
    'refuses a corrupted private frame before changing the canonical RNG or invoking a second decision (windows=%s)',
    async (windows) => {
      HorseMind.reset();
      if (windows)
        HorseMind.importStats([
          {
            user_id: 'horse-3',
            hands: 20,
            sourceWindow: { version: 1, coverage: 'complete', fromMs: 100, toMs: 200 },
          },
        ]);
      try {
        const h = harness(),
          request = fastRequest(1);
        h.runtime.receive(request);
        await h.runtime.drain();
        const fast = h.messages.find((m) => m.type === 'FAST_RESULT');
        if (fast?.type !== 'FAST_RESULT') throw Error('missing fast');
        const entry = [...(h.runtime as any).secondLookReads.values()][0] as any;
        expect(entry.frame.version).toBe(
          windows ? 'horse-decision-reads-v3' : 'horse-decision-reads-v2'
        );
        if (windows)
          expect(JSON.parse(entry.frame.json).statsWindows[0][1]).toMatchObject({
            fromMs: 100,
            toMs: 200,
          });
        expect(JSON.stringify(fast)).not.toContain('horse-decision-reads-');
        entry.frame = { ...entry.frame, sha256: '0'.repeat(64) };
        const restores = h.restored.length;
        h.runtime.receive({
          ...request,
          type: 'DECIDE_DEEP',
          requestId: 2,
          rngBefore: fast.rngBefore,
          deepEquity: 2,
        });
        await h.runtime.drain();
        expect(h.messages.at(-1)).toMatchObject({
          type: 'ERROR',
          recoverable: true,
          message: 'Horse decision read frame is invalid',
        });
        expect(h.decisionsAtRng).toHaveLength(1);
        expect(h.restored).toHaveLength(restores);
      } finally {
        HorseMind.reset();
      }
    }
  );

  it('keeps the actual second-look opponent reads pinned after other table observations', async () => {
    const { hero, state } = jointPolicyFixture('nlh', 1, 'cash', 'flop');
    const h = harness(true);
    HorseMind.reset();
    HorseMind.importStats([{ user_id: 'p1', hands: 80, folds: 70, facedAggr: 80 }]);
    const reads: number[] = [];
    const real = HorseMind.exploit.bind(HorseMind);
    const spy = vi.spyOn(HorseMind, 'exploit').mockImplementation((id, recency) => {
      const value = real(id, recency);
      if (id === 'p1') reads.push(value.bluffMod);
      return value;
    });
    try {
      const request = rekey({
        ...fastRequest(1),
        player: hero,
        gameState: state,
        opts: { phase13Joint: 'off' },
      });
      h.runtime.receive(request);
      await h.runtime.drain();
      const fast = h.messages.find((m) => m.type === 'FAST_RESULT');
      if (fast?.type !== 'FAST_RESULT') throw Error(JSON.stringify(h.messages));
      expect(reads.length).toBeGreaterThan(0);
      const original = reads[0];
      HorseMind.importStats([{ user_id: 'p1', hands: 800, folds: 70, facedAggr: 800 }]);
      expect(real('p1', false).bluffMod).not.toBe(original);
      reads.length = 0;
      h.runtime.receive({
        ...request,
        type: 'DECIDE_DEEP',
        requestId: 2,
        rngBefore: fast.rngBefore,
        deepEquity: 2,
      });
      await h.runtime.drain();
      expect(h.messages.at(-1)?.type).toBe('DEEP_RESULT');
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((v) => v === original)).toBe(true);
      expect(HorseMind.getStats('p1')?.hands).toBe(800);
    } finally {
      spy.mockRestore();
      HorseMind.reset();
    }
  });

  it.each([
    'missing',
    'expired',
    'generation',
    'fence',
    'clock',
    'rng',
    'snapshot',
    'ambiguous',
    'consumed',
  ] as const)('keeps the fast action available when second-look reads are %s', async (mode) => {
    const h = harness();
    const request = fastRequest(1);
    h.runtime.receive(request);
    await h.runtime.drain();
    const fast = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (fast?.type !== 'FAST_RESULT') throw Error('fast result missing');
    const deep = {
      ...request,
      type: 'DECIDE_DEEP' as const,
      requestId: 3,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    };
    if (mode === 'missing') {
      deep.player = { ...deep.player, username: 'different' };
    }
    if (mode === 'generation') deep.generation++;
    if (mode === 'fence') deep.fence += 'changed';
    if (mode === 'clock') deep.decisionTimeMs++;
    if (mode === 'rng') deep.rngBefore++;
    if (mode === 'snapshot') deep.style = 'lag';
    if (mode === 'expired') h.advanceClock(60_001);
    if (mode === 'ambiguous') {
      h.runtime.receive({ ...request, requestId: 2 });
      await h.runtime.drain();
    }
    if (mode === 'consumed') {
      h.runtime.receive({ ...deep, requestId: 2 });
      await h.runtime.drain();
    }
    deep.decisionKey = buildHorseDecisionKey(deep);
    const before = h.decisionsAtRng.length;
    h.runtime.receive(deep);
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      recoverable: true,
      message: 'second look original opponent reads unavailable',
    });
    expect(h.decisionsAtRng).toHaveLength(before);
    expect(h.rng()).toBe(101);
    h.runtime.receive(rekey({ ...request, requestId: 4, fence: 'next-turn' }));
    await h.runtime.drain();
    expect(h.messages.at(-1)?.type).toBe('FAST_RESULT');
  });

  it('bounds retained reads and clears them on shutdown', async () => {
    const h = harness();
    for (let i = 1; i <= 140; i++)
      h.runtime.receive(rekey({ ...fastRequest(i), fence: `turn-${i}` }));
    await h.runtime.drain();
    expect((h.runtime as any).secondLookReads.size).toBe(128);
    const first = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (first?.type !== 'FAST_RESULT') throw Error('fast result missing');
    const request = rekey({ ...fastRequest(141), fence: 'turn-1' });
    h.runtime.receive({
      ...request,
      type: 'DECIDE_DEEP',
      rngBefore: first.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({ type: 'ERROR', recoverable: true });
    h.runtime.receive({ type: 'SHUTDOWN' });
    await h.runtime.drain();
    expect((h.runtime as any).secondLookReads.size).toBe(0);
  });

  it('replays deep work from rngBefore and always restores canonical worker RNG', async () => {
    const h = harness();
    h.setCapturedEffects([
      { type: 'plan', handKey: 'speculative', userId: 'horse-2', barrelIntent: true },
    ]);
    await h.runtime.start();
    h.setRng(900);
    h.runtime.receive(fastRequest(1));
    await h.runtime.drain();
    const fast = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (fast?.type !== 'FAST_RESULT') throw Error('fast decision missing');
    h.decisionsAtRng.length = 0;
    h.restored.length = 0;
    h.decisionOpts.length = 0;
    h.features.length = 0;
    h.latency.length = 0;
    h.runtime.receive({
      ...snapshot,
      type: 'DECIDE_DEEP',
      requestId: 2,
      rngBefore: fast.rngBefore,
      deepEquity: 6,
    });
    await h.runtime.drain();

    expect(h.decisionsAtRng).toEqual([fast.rngBefore]);
    expect(h.restored).toEqual([fast.rngBefore, 900]);
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
    h.runtime.receive(fastRequest(1));
    await h.runtime.drain();
    const fast = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (fast?.type !== 'FAST_RESULT') throw Error('fast decision missing');
    h.restored.length = 0;
    h.setThrowDecision(true);
    h.runtime.receive({
      ...snapshot,
      type: 'DECIDE_DEEP',
      requestId: 3,
      rngBefore: fast.rngBefore,
      deepEquity: 6,
    });
    await h.runtime.drain();

    expect(h.rng()).toBe(444);
    expect(h.restored).toEqual([fast.rngBefore, 444]);
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

  it('does not acknowledge shutdown if a final owned telemetry batch is unconfirmed', async () => {
    const h = harness();
    h.setStopFailure(new Error('Horse telemetry batch write unconfirmed'));
    h.runtime.receive(fastRequest(1));
    h.runtime.receive({ type: 'SHUTDOWN' });
    await h.runtime.drain();
    expect(h.messages.map((message) => message.type)).toEqual(['READY', 'FAST_RESULT', 'ERROR']);
    expect(h.messages.at(-1)).toMatchObject({
      requestId: null,
      message: 'Horse telemetry batch write unconfirmed',
    });
    expect(h.stopped()).toBe(1);
  });

  it('drops partial decision effects when the real brain catches an evaluation failure', async () => {
    const h = harness(true);
    h.setCapturedEffects([
      {
        type: 'raise_plan',
        handKey: 'table:hand',
        userId: 'horse-2',
        street: 'flop',
        plan: 'foldToRaise',
      },
    ]);
    const failed = vi.spyOn(HorseLogic as any, 'decideInternal').mockImplementation(() => {
      throw Error('failed policy evaluation');
    });
    try {
      h.runtime.receive(fastRequest(1));
      await h.runtime.drain();
      expect(h.messages.at(-1)).toMatchObject({
        type: 'FAST_RESULT',
        decision: { action: 'fold', policyFallback: 'brain_exception' },
        effects: [],
      });
      expect(h.appliedEffects).toEqual([]);
    } finally {
      failed.mockRestore();
    }
  });

  it('refuses a caller batch that the FAST policy retired instead of treating explicit FIFO submission as issue proof', async () => {
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
      planBinding: horsePlanBatchBindingFromRequest(fastRequest(1)),
      generation: 4,
      fence: 'table:hand:turn',
      effects,
    });
    await h.runtime.drain();

    // The call's emitted batch is empty. A caller cannot revive its retired
    // speculative wager plans by submitting a separately assembled commit.
    expect(h.messages[1]).toMatchObject({ type: 'FAST_RESULT', effects: [] });
    expect(h.appliedEffects).toEqual([]);
    expect(h.messages[2]).toMatchObject({ type: 'ERROR', recoverable: true });
  });

  it('retires captured wager plans when the final policy returned a call', async () => {
    const h = harness();
    h.setCapturedEffects([
      { type: 'plan', handKey: 'table:hand', userId: 'horse-2', barrelIntent: true },
    ]);
    h.runtime.receive(fastRequest(1));
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({
      type: 'FAST_RESULT',
      decision: { action: 'call' },
      effects: [],
    });
  });

  it('refuses a malformed commit before applying any effect and keeps the next request usable', async () => {
    const h = harness();
    h.runtime.receive({
      type: 'COMMIT_DECISION_EFFECTS',
      requestId: 2,
      planBinding: horsePlanBatchBindingFromRequest(fastRequest(1)),
      generation: 4,
      fence: 'table:hand:turn',
      effects: [
        { type: 'plan', handKey: 'table:hand', userId: 'horse-2', barrelIntent: true },
        {
          type: 'outlook',
          handKey: 'table:hand',
          userId: 'horse-2',
          street: 'flop',
          good: null,
          scare: [],
        } as any,
      ],
    });
    h.runtime.receive(fastRequest(3));
    await h.runtime.drain();
    expect(h.appliedEffects).toEqual([]);
    expect(h.messages[1]).toMatchObject({ type: 'ERROR', requestId: 2, recoverable: true });
    expect(h.messages[2]).toMatchObject({ type: 'FAST_RESULT', requestId: 3 });
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

  it('privately captures discard input, output and seeded RNG without changing the public result', async () => {
    const h = harness();
    const captures: unknown[] = [];
    h.deps.journalEnabled = () => true;
    (
      h.deps as HorseDecisionWorkerDependencies & { journalDiscard?: (value: unknown) => void }
    ).journalDiscard = (value) => captures.push(structuredClone(value));
    const request = {
      type: 'DECIDE_DISCARD' as const,
      requestId: 77,
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
    h.runtime.receive(request);
    await h.runtime.drain();
    expect(captures).toEqual([
      expect.objectContaining({
        version: 1,
        snapshot: request,
        cardIndex: 1,
        rngBefore: h.decisionsAtRng[0],
        rngAfter: 303,
        runtimePins: 'incomplete',
        computeMs: 6,
        governorScale: 0.2,
      }),
    ]);
    expect(h.messages.at(-1)).toEqual({
      type: 'DISCARD_RESULT',
      requestId: 77,
      generation: 4,
      fence: request.fence,
      cardIndex: 1,
      computeMs: 6,
      governorScale: 0.2,
    });
    expect(h.rng()).toBe(101);
  });

  it('keeps discard play and canonical RNG intact when private capture fails', async () => {
    const h = harness();
    h.deps.journalEnabled = () => true;
    (h.deps as HorseDecisionWorkerDependencies & { journalDiscard?: () => void }).journalDiscard =
      () => {
        throw Error('private journal unavailable');
      };
    h.runtime.receive({
      type: 'DECIDE_DISCARD',
      requestId: 78,
      generation: 4,
      fence: 'table:hand:discard:2',
      cards: structuredClone(pineappleCards),
      communityCards: [
        { rank: '7', suit: 'hearts' },
        { rank: '8', suit: 'hearts' },
        { rank: '3', suit: 'clubs' },
      ],
      gameVariant: 'pineapple',
    });
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({ type: 'DISCARD_RESULT', cardIndex: 1 });
    expect(h.features).toContain('phase15_journal_discard_capture_unavailable');
    expect(h.rng()).toBe(101);
  });

  it.each(['accepted', 'missing_private_card', 'wrong_envelope', 'publisher_failed'])(
    'validates and transports private controller discard evidence: %s',
    async (mode) => {
      const h = harness();
      const table = '10000000-0000-4000-8000-000000000001';
      const actor = '20000000-0000-4000-8000-000000000001';
      const cards: Card[] = structuredClone(pineappleCards);
      const communityCards: Card[] = [
        { rank: '7', suit: 'hearts' },
        { rank: '8', suit: 'hearts' },
        { rank: '3', suit: 'clubs' },
      ];
      const fence = [
        table,
        12,
        'pineapple-discard',
        2,
        '9',
        4,
        cards.map((c) => `${c.rank}:${c.suit}`).join('|'),
        communityCards.map((c) => `${c.rank}:${c.suit}`).join('|'),
      ].join(':');
      const priorActions = captureHorseHandJournalContext([])!;
      const execution: HorseDiscardExecutionObservation = {
        version: 1,
        request: {
          type: 'DECIDE_DISCARD',
          requestId: 3,
          generation: 4,
          fence,
          cards,
          communityCards,
          gameVariant: 'pineapple',
          journalContext: {
            version: 1,
            tableId: table,
            handNumber: 12,
            leaseGeneration: '9',
            actorId: actor,
            seat: 2,
            requestedAtMs: 1000,
            lane: 'choice',
            priorActions,
          },
        },
        selectedIndex: 1,
        acceptedActionOrdinal: 0,
        priorActions,
        controller: {
          seat: 2,
          actorId: actor,
          chosenIndex: 1,
          originalCards: structuredClone(cards),
          discardedCard: cards[1]!,
          retainedCards: cards.filter((_, i) => i !== 1),
          communityCards: structuredClone(communityCards),
          acceptedRecord: {
            seat: 2,
            userId: actor,
            action: 'discard',
            amount: 0,
            timestamp: 1001,
            stage: 'pineapple_discard',
          },
        },
      };
      const captures: unknown[] = [];
      h.deps.journalDiscardExecution = (value) => {
        if (mode === 'publisher_failed') throw Error('private store unavailable');
        captures.push(structuredClone(value));
      };
      if (mode === 'missing_private_card') (execution.controller as any).discardedCard = null;
      h.runtime.receive({
        type: 'OBSERVE_DISCARD_EXECUTION',
        requestId: 10,
        generation: 4,
        fence: mode === 'wrong_envelope' ? 'another-fence' : fence,
        execution,
      });
      await h.runtime.drain();
      if (mode === 'accepted' || mode === 'publisher_failed') {
        expect(h.messages.at(-1)).toMatchObject({
          type: 'ACK',
          operation: 'OBSERVE_DISCARD_EXECUTION',
        });
        expect(captures).toHaveLength(mode === 'accepted' ? 1 : 0);
      } else {
        expect(h.messages.at(-1)).toMatchObject({ type: 'ERROR', recoverable: true });
        expect(captures).toEqual([]);
      }
      if (mode === 'publisher_failed')
        expect(h.features).toContain('phase15_journal_discard_capture_unavailable');
      expect(JSON.stringify(h.messages)).not.toContain('discardedCard');
      expect(h.rng()).toBe(101);
      expect(h.decisionsAtRng).toEqual([]);
    }
  );

  it('detaches private discard input before computation and respects a disabled journal', async () => {
    const request = {
      type: 'DECIDE_DISCARD' as const,
      requestId: 91,
      generation: 4,
      fence: 'table:hand:discard:2',
      cards: structuredClone(pineappleCards),
      communityCards: [
        { rank: '7', suit: 'hearts' },
        { rank: '8', suit: 'hearts' },
        { rank: '3', suit: 'clubs' },
      ] as Card[],
      gameVariant: 'pineapple',
    };
    const original = structuredClone(request);
    const h = harness();
    const captures: unknown[] = [];
    h.deps.journalEnabled = () => true;
    h.deps.journalDiscard = (value) => captures.push(value);
    h.deps.decideDiscard = (cards) => {
      cards[0]!.rank = '2';
      return 1;
    };
    h.runtime.receive(request);
    await h.runtime.drain();
    expect(captures[0]).toMatchObject({ snapshot: original });
    const disabled = harness();
    disabled.deps.journalEnabled = () => false;
    disabled.deps.journalDiscard = () => {
      throw Error('should not capture');
    };
    disabled.runtime.receive(original);
    await disabled.runtime.drain();
    expect(disabled.messages.at(-1)).toMatchObject({ type: 'DISCARD_RESULT', cardIndex: 1 });
    expect(disabled.features).not.toContain('phase15_journal_discard_capture_unavailable');
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

  it('planted red: journals the governor scale the decision ran at, not a reading taken after it (Phase 6C)', async () => {
    const h = harness();
    // Each read of the live governor may take a new reading (one a second).
    const readings = [0.6, 1, 0.35, 0.2];
    let pinned: number | null = null;
    const live = () => pinned ?? readings.shift() ?? 0.08;
    const seenByDecision: number[] = [];
    const journaled: number[] = [];
    h.deps.governorScale = live;
    h.deps.atGovernorScale = <T>(fn: () => T) => {
      const scale = live();
      pinned = scale;
      try {
        return { value: fn(), scale };
      } finally {
        pinned = null;
      }
    };
    const decide = h.deps.decide;
    h.deps.decide = (...args) => {
      // Two Monte Carlo reads inside the one decision.
      seenByDecision.push(live(), live());
      return decide(...args);
    };
    h.deps.journalEnabled = () => true;
    h.deps.journalDecision = (_request, payload) => {
      journaled.push((payload as { governorScale: number }).governorScale);
    };
    h.runtime.receive(fastRequest());
    await h.runtime.drain();
    const result = h.messages.find((m) => m.type === 'FAST_RESULT');
    expect(seenByDecision).toEqual([0.6, 0.6]);
    expect(journaled).toEqual([0.6]);
    expect(result).toMatchObject({ governorScale: 0.6 });
  });

  it('without a decision-scale hook, reads the governor once, before the decision', async () => {
    const h = harness();
    const reads: string[] = [];
    let phase = 'before';
    h.deps.governorScale = () => {
      reads.push(phase);
      return 0.35;
    };
    const decide = h.deps.decide;
    h.deps.decide = (...args) => {
      phase = 'during';
      const out = decide(...args);
      phase = 'after';
      return out;
    };
    h.runtime.receive(fastRequest());
    await h.runtime.drain();
    expect(reads).toEqual(['before']);
    expect(h.messages.find((m) => m.type === 'FAST_RESULT')).toMatchObject({ governorScale: 0.35 });
  });

  it('captures actual fast/deep journal inputs privately and retains decisions when capture fails', async () => {
    const h = harness(),
      records: any[] = [];
    h.deps.journalDecision = (request, payload) => records.push({ request, payload });
    const fast = fastRequest();
    h.runtime.receive(fast);
    await h.runtime.drain();
    const first = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (first?.type !== 'FAST_RESULT') throw Error('missing fast result');
    expect(records[0].payload).toMatchObject({
      snapshot: { requestId: 1 },
      readFrame: { version: 'horse-decision-reads-v2' },
      rngBefore: first.rngBefore,
      rngAfter: first.rngAfter,
      runtimePins: 'incomplete',
    });
    expect(JSON.stringify(first)).not.toContain('horse-decision-reads-v2');
    h.runtime.receive({
      ...fast,
      type: 'DECIDE_DEEP',
      requestId: 2,
      rngBefore: first.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    expect(records[1].payload).toMatchObject({
      snapshot: { requestId: 2 },
      readFrame: records[0].payload.readFrame,
      rngBefore: first.rngBefore,
      rngAfter: 202,
    });
    h.deps.journalDecision = () => {
      throw Error('disk unavailable');
    };
    h.runtime.receive(fastRequest(3));
    await h.runtime.drain();
    expect(h.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId: 3 });
    expect(h.features).toContain('phase15_journal_capture_unavailable');
  });

  it('validates accepted-history diagnostics without changing the actual worker RNG stream', async () => {
    const clean = fastRequest();
    const captured = rekey({
      ...clean,
      handJournalContext: { version: 1, actionCount: 4, actionsDigest: 'a'.repeat(64) },
    });
    const a = harness(),
      b = harness(),
      tampered = harness();
    a.runtime.receive(clean);
    b.runtime.receive(captured);
    tampered.runtime.receive({ ...captured, decisionKey: clean.decisionKey });
    await Promise.all([a.runtime.drain(), b.runtime.drain(), tampered.runtime.drain()]);
    expect(b.decisionsAtRng).toEqual(a.decisionsAtRng);
    expect(b.decisionsAtRng).toHaveLength(1);
    expect(tampered.decisionsAtRng).toEqual([]);
    expect(tampered.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      recoverable: true,
      message: 'decisionKey does not bind the canonical decision snapshot',
    });
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
  // Heads-up the button posts the small blind (HandController's walk).
  request.gameState.blindSeats = { smallBlind: 2, bigBlind: 3 };
  request.decisionKey = buildHorseDecisionKey(request);
  const journaled: Array<{ readFrame: { sha256: string } | null }> = [];
  h.deps.journalEnabled = () => true;
  h.deps.journalDecision = (_request, payload) =>
    journaled.push(payload as unknown as (typeof journaled)[number]);
  // This proves execution/wiring, not latency. A shared runner pause cannot
  // be required to fit the production 4 ms window. Budget refusal is tested
  // independently by Plo4LivePolicy; no live request clock control is enabled.
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    h.runtime.receive(request);
    await h.runtime.drain();
  } finally {
    clock.mockRestore();
  }
  const result = h.messages.find((m) => m.type === 'FAST_RESULT');
  if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(h.messages));
  expect(result.decision.plo4Policy?.mode).toBe('shadow');
  expect(result.decision.plo4Policy?.eligible).toBe(true);
  expect(result.decision.plo4Policy?.fired).toBe(true);
  expect(structuredClone(result).decision.plo4Policy?.finalAction).toBe(result.decision.action);
  // P10.1: the frozen input binding crosses the boundary bound to the same
  // private read frame the journal retained for this decision.
  const receipt = result.decision.plo4Policy!;
  expect(plo4Live.plo4LiveReceiptBindingIsValid(structuredClone(receipt))).toBe(true);
  expect(receipt.inputs?.census.dealerSeat).toBe(2);
  expect(receipt.inputs?.positions.hero).toBe('button');
  expect(receipt.readFrameSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(journaled).toHaveLength(1);
  expect(receipt.readFrameSha256).toBe(journaled[0].readFrame?.sha256);
  expect(horseDecisionReceiptIsValid(structuredClone(result.decision), 'plo4')).toBe(true);
  const forged = structuredClone(result.decision) as any;
  forged.plo4Policy.inputs.approximation.solverInput = true;
  expect(horseDecisionReceiptIsValid(forged, 'plo4')).toBe(false);
  const relabeled = structuredClone(result.decision) as any;
  relabeled.plo4Policy.inputs.range.provenance = { source: 'solver' };
  expect(horseDecisionReceiptIsValid(relabeled, 'plo4')).toBe(false);
  // A retained legacy receipt without the field claims no binding and stays readable.
  const legacy = structuredClone(result.decision) as any;
  delete legacy.plo4Policy.inputs;
  delete legacy.plo4Policy.readFrameSha256;
  expect(horseDecisionReceiptIsValid(legacy, 'plo4')).toBe(true);
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
      // P11.1: the frozen input binding crosses the boundary intact.
      const receipt = structuredClone(result.decision.omahaVariantPolicy!);
      expect(omahaVariantReceiptBindingIsValid(receipt)).toBe(true);
      expect(receipt.inputs).toMatchObject({
        variant,
        census: { dealerSeat: 1, blindSeats: input.state.blindSeats },
        positions: { hero: 'button' },
        range: { status: 'not_consumed_preflop' },
      });
      expect(horseDecisionReceiptIsValid(structuredClone(result.decision), variant)).toBe(true);
      const forged = structuredClone(result.decision) as any;
      forged.omahaVariantPolicy.inputs.pack.calibratedConfidence = 0.99;
      expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
      const legacy = structuredClone(result.decision) as any;
      delete legacy.omahaVariantPolicy.inputs;
      expect(horseDecisionReceiptIsValid(legacy, variant)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  }
);

it.each(['short_deck', 'pineapple', 'flh', 'flo8'] as const)(
  'Phase 12 %s receipt survives the live worker boundary',
  async (variant) => {
    // Same clock discipline as the Phase 11 sibling above, and for the same
    // reason. This fixture proves the receipt reaches the worker result; it is
    // not a budget test. evaluateRemainingVariantPolicy reads `now()` and marks
    // the receipt `fired: false, reason: 'work_budget'` once the elapsed live
    // budget is exceeded (RemainingVariantLivePolicy.ts), so on a contended box
    // this asserted a timing race rather than the receipt boundary.
    //
    // 2026-09-14: observed failing exactly that way on the estate runners,
    // which pack 12-18 runners per host and are therefore far more contended
    // than a dedicated hosted VM. short_deck returned fired=false while the
    // three other variants passed, and it passed on rerun. Phase 11 was already
    // guarded; this one was written without the guard. The budget itself stays
    // covered by the dedicated policy-budget tests and the actual-controller
    // benchmark, which keep their time limits.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
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
      // P12.1: the frozen input binding crosses the boundary intact.
      const receipt = structuredClone(result.decision.remainingVariantPolicy!);
      expect(remainingVariantReceiptBindingIsValid(receipt)).toBe(true);
      expect(receipt.inputs).toMatchObject({
        variant,
        mode: 'cash',
        census: { dealerSeat: 1, blindSeats: input.state.blindSeats },
        positions: { hero: 'button' },
        privateCards: { cardValues: 'not_recorded' },
        range: { status: 'not_consumed_preflop' },
      });
      expect(horseDecisionReceiptIsValid(structuredClone(result.decision), variant)).toBe(true);
      const forged = structuredClone(result.decision) as any;
      forged.remainingVariantPolicy.inputs.pack.calibratedConfidence = 0.99;
      expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
      const legacy = structuredClone(result.decision) as any;
      delete legacy.remainingVariantPolicy.inputs;
      expect(horseDecisionReceiptIsValid(legacy, variant)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  }
);

describe('Phase 8.3 worker-owned qualified authority', () => {
  function authorityHarness(admission?: HorseAuthorityAdmission) {
    const h = harness();
    let safety: string | null = null;
    const ledgers: Array<Record<string, unknown>> = [];
    let tripOnDecision = false;
    h.deps.admitPhase8Authority = admission ? () => admission : undefined;
    h.deps.phase8SafetyDisabledReason = () => safety;
    const decide = h.deps.decide;
    h.deps.decide = (player, gameState, style, mods, opts) => {
      const decision = decide(player, gameState, style, mods, opts);
      // A minimal Phase 8 receipt as HorseLogic attaches it.
      const ledger = { mode: opts?.phase8Postflop, authority: null };
      ledgers.push(ledger);
      if (tripOnDecision) safety = 'critical_commitment_increase';
      return { ...decision, tournamentPostflop: ledger } as unknown as typeof decision;
    };
    return {
      ...h,
      ledgers,
      tripSafety: (reason: string) => {
        safety = reason;
      },
      tripOnNextDecision: () => {
        tripOnDecision = true;
      },
      results: () =>
        h.messages.filter(
          (m): m is Extract<HorseDecisionWorkerResponse, { type: 'FAST_RESULT' | 'DEEP_RESULT' }> =>
            m.type === 'FAST_RESULT' || m.type === 'DEEP_RESULT'
        ),
    };
  }

  it('without a committed selection every live decision is shadow and the caller may only turn it off', async () => {
    const h = authorityHarness();
    h.runtime.receive(fastRequest(1));
    h.runtime.receive(rekey({ ...fastRequest(2), opts: { phase8Postflop: 'off' } }));
    await h.runtime.drain();
    expect(h.decisionOpts.map((o) => o.phase8Postflop)).toEqual(['shadow', 'off']);
    expect(h.results().map((r) => r.phase8Authority?.state)).toEqual(['unselected', 'unselected']);
    expect(h.ledgers[0].authority).toMatchObject({
      state: 'unselected',
      continuationVersion: 'horse-tournament-postflop-round1-v4',
      mainGeneration: null,
    });
  });

  it('derives candidate mode from admitted authority and binds its generation to the ledger', async () => {
    const h = authorityHarness(qualifiedTestAdmission(1));
    h.runtime.receive(fastRequest(1));
    await h.runtime.drain();
    expect(h.decisionOpts[0].phase8Postflop).toBe('candidate');
    const result = h.results()[0];
    expect(result.phase8Authority).toMatchObject({
      state: 'usable',
      generation: 1,
      approvalGeneration: 1,
    });
    expect(h.ledgers[0].authority).toEqual(result.phase8Authority);
  });

  it('a caller still cannot supply candidate control when authority is usable', async () => {
    const h = authorityHarness(qualifiedTestAdmission(1));
    h.runtime.receive({
      ...fastRequest(1),
      opts: { phase8Postflop: 'candidate' },
    } as unknown as FastHorseDecisionRequest);
    await h.runtime.drain();
    expect(h.decisionOpts).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'offline candidate controls are forbidden in live decision requests',
    });
  });

  it('work queued before a withdrawal runs in shadow, and the deciding receipt is stale', async () => {
    const h = authorityHarness(qualifiedTestAdmission(1));
    h.tripOnNextDecision();
    h.runtime.receive(fastRequest(1));
    h.runtime.receive(fastRequest(2));
    await h.runtime.drain();
    expect(h.decisionOpts.map((o) => o.phase8Postflop)).toEqual(['candidate', 'shadow']);
    const [first, second] = h.results();
    // The first decision was admitted at generation 1; its own result already
    // reports the withdrawal it caused, so the main scheduler sees it stale.
    expect(h.ledgers[0].authority).toMatchObject({ state: 'usable', generation: 1 });
    expect(first.phase8Authority).toMatchObject({
      state: 'withdrawn',
      generation: 2,
      reason: 'safety_critical_commitment_increase',
    });
    expect(second.phase8Authority).toMatchObject({ state: 'withdrawn', generation: 2 });
    expect(h.ledgers[1].authority).toMatchObject({ state: 'withdrawn' });
  });

  it('deep think-time work admits afresh and turns to shadow after a withdrawal', async () => {
    const h = authorityHarness(qualifiedTestAdmission(1));
    const request = fastRequest(1);
    h.runtime.receive(request);
    await h.runtime.drain();
    const fast = h.results()[0];
    if (fast.type !== 'FAST_RESULT') throw Error('expected FAST_RESULT');
    expect(h.decisionOpts[0].phase8Postflop).toBe('candidate');
    h.tripSafety('eligible_but_silent');
    h.runtime.receive({
      ...request,
      type: 'DECIDE_DEEP',
      requestId: 2,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    const deep = h.results()[1];
    expect(deep.type).toBe('DEEP_RESULT');
    expect(h.decisionOpts[1].phase8Postflop).toBe('shadow');
    expect(deep.phase8Authority).toMatchObject({
      state: 'withdrawn',
      reason: 'safety_eligible_but_silent',
    });
  });

  it('a refused or transiently unreadable selection never yields candidate mode', async () => {
    for (const admission of [
      { status: 'refused', reason: 'hash_mismatch', transient: false },
      { status: 'refused', reason: 'unreadable_evidence', transient: true },
      { status: 'withdrawn', approvalGeneration: 1, reason: 'release_owner' },
    ] as const) {
      const h = authorityHarness(admission);
      h.runtime.receive(fastRequest(1));
      await h.runtime.drain();
      expect(h.decisionOpts[0].phase8Postflop).toBe('shadow');
      expect(h.results()[0].phase8Authority?.state).not.toBe('usable');
    }
  });
});

describe('P10.3 worker-owned PLO4 authority (the Phase 8 path, reused)', () => {
  const plo4Cash = (requestId: number, cards: string): FastHorseDecisionRequest =>
    rekey({
      ...fastRequest(requestId),
      player: { ...snapshot.player, cards: plo4Cards(cards) },
      gameState: {
        ...structuredClone(snapshot.gameState),
        dealerSeat: 2,
        // Heads-up the button posts the small blind (HandController's walk).
        blindSeats: { smallBlind: 2, bigBlind: 3 },
      },
      style: 'balanced',
      mods: {},
      opts: { mind: false },
    });
  const plo4Tournament = (requestId: number, cards: string): FastHorseDecisionRequest => {
    const base = phase6TournamentRequest(requestId);
    return rekey({
      ...base,
      player: { ...snapshot.player, cards: plo4Cards(cards) },
      gameState: {
        ...base.gameState,
        gameVariant: 'plo4',
        bettingStructure: 'pot_limit',
        variantRules: snapshot.gameState.variantRules,
        legalActions: snapshot.gameState.legalActions,
        minRaiseTo: snapshot.gameState.minRaiseTo,
        maxRaiseTo: snapshot.gameState.maxRaiseTo,
        // Heads-up the button (seat 2) posts the small blind.
        blindSeats: { smallBlind: 2, bigBlind: 3 },
        tournament: { ...base.gameState.tournament!, gameVariant: 'plo4' },
      },
      style: 'balanced',
      mods: {},
      opts: { mind: false },
    });
  };
  /** One real worker decision. The HorseLogic RNG is seeded identically for
   * every run, so two runs differ only by what the worker admitted. */
  async function decideThrough(
    request: FastHorseDecisionRequest,
    admission?: () => HorseAuthorityAdmission,
    packOff = false
  ) {
    const h = harness(true);
    h.deps.admitPhase10Authority = admission;
    const decide = h.deps.decide;
    h.deps.decide = (player, gameState, style, mods, opts) => {
      const rng = saveFastRandom();
      seedFastRandom(10_300_003);
      try {
        return decide(
          player,
          gameState,
          style,
          mods,
          packOff ? { ...opts, phase10Plo4: 'off' } : opts
        );
      } finally {
        restoreFastRandom(rng);
      }
    };
    // Wiring, not latency: the 4 ms budget is tested by Plo4LivePolicy.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      h.runtime.receive(request);
      await h.runtime.drain();
    } finally {
      clock.mockRestore();
    }
    const result = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(h.messages));
    return { h, result, decision: result.decision };
  }
  const act = (d: { action: string; amount?: number }) => ({
    action: d.action,
    amount: d.amount ?? null,
  });

  // Actions pinned from the unmodified P10.1 base (current main's policy):
  // the pack is shadow there, so these are the reference actions it executes.
  // Run through this same harness on the unmodified P10.1 base before the
  // change (before-tests-with-admission-module-only.log, the PIN run).
  const LIVE_STATES = [
    [
      'cash AsKsQhJh preflop (the pack proposes raise 10)',
      'cash',
      'As Ks Qh Jh',
      true,
      { action: 'call', amount: 2 },
    ],
    [
      'cash QsQh4c4d preflop (the pack proposes fold)',
      'cash',
      'Qs Qh 4c 4d',
      true,
      { action: 'call', amount: 2 },
    ],
    [
      'cash Ah7c2s3d preflop (the pack agrees)',
      'cash',
      'Ah 7c 2s 3d',
      false,
      { action: 'fold', amount: null },
    ],
    [
      'tournament AsKsQhJh preflop (the pack proposes raise 10)',
      'tournament',
      'As Ks Qh Jh',
      true,
      { action: 'call', amount: 2 },
    ],
  ] as const;

  it.each(LIVE_STATES)(
    'live behaviour is unchanged today: %s executes the same action as current main',
    async (_name, format, cards, changed, mainAction) => {
      const request = format === 'cash' ? plo4Cash(601, cards) : plo4Tournament(601, cards);
      const live = await decideThrough(request, () => admitHorsePhase10ReleaseAuthority());
      const reference = await decideThrough(request, undefined, true);
      expect(live.h.decisionOpts[0].phase10Plo4).toBe('shadow');
      expect(act(live.decision)).toEqual(mainAction);
      expect(act(reference.decision)).toEqual(mainAction);
      expect(reference.decision.plo4Policy).toBeUndefined();
      const receipt = live.decision.plo4Policy!;
      expect(receipt).toMatchObject({
        mode: 'shadow',
        applied: false,
        authorityVerdict: null,
        selectionRefusal: null,
        authority: { state: 'unselected', reason: 'unselected', authorityKey: null },
      });
      expect(receipt.changed).toBe(changed);
      expect(receipt.selection).toBe(receipt.changed ? 'shadow_change' : 'none');
      expect(receipt.finalAction).toBe(live.decision.action);
      expect(live.result.phase10Authority).toMatchObject({
        state: 'unselected',
        continuationVersion: 'plo4-policy-round1-v3',
      });
      expect(horseDecisionReceiptIsValid(structuredClone(live.decision), 'plo4')).toBe(true);
    }
  );

  it.each([
    [
      'missing',
      () =>
        admitHorsePhase10QualifiedAuthority(
          p10Selection(),
          memoryReader({}),
          P10_TEST_NOW,
          P10_TEST_CONTRACT_DIGEST
        ),
      'missing_evidence',
    ],
    [
      'qualified:false',
      () => {
        const q = p10QualificationBytes({ qualified: false });
        return admitHorsePhase10QualifiedAuthority(
          p10Selection(q),
          p10Reader(q),
          P10_TEST_NOW,
          P10_TEST_CONTRACT_DIGEST
        );
      },
      'not_qualified',
    ],
    [
      'wrong-digest',
      () => {
        const q = p10QualificationBytes({ contractDigest: 'e'.repeat(64) });
        return admitHorsePhase10QualifiedAuthority(
          p10Selection(q),
          p10Reader(q),
          P10_TEST_NOW,
          P10_TEST_CONTRACT_DIGEST
        );
      },
      'contract_digest_mismatch',
    ],
    [
      'wrong-source',
      () => {
        const q = p10QualificationBytes({ sourceSha: 'c'.repeat(40) });
        return admitHorsePhase10QualifiedAuthority(
          p10Selection(q),
          p10Reader(q),
          P10_TEST_NOW,
          P10_TEST_CONTRACT_DIGEST
        );
      },
      'source_mismatch',
    ],
  ] as const)(
    'a %s qualification file keeps the pack in shadow and the reference action',
    async (_name, admission, reason) => {
      const request = plo4Cash(602, 'As Ks Qh Jh');
      const refused = await decideThrough(request, admission);
      const reference = await decideThrough(request, undefined, true);
      expect(refused.h.decisionOpts[0].phase10Plo4).toBe('shadow');
      expect(act(refused.decision)).toEqual(act(reference.decision));
      expect(refused.decision.plo4Policy).toMatchObject({
        mode: 'shadow',
        changed: true,
        applied: false,
        selection: 'shadow_change',
        authority: { state: 'refused', reason },
      });
    }
  );

  it('a valid qualified file (test fixture only) selects the cash proposal and records selected and baseline actions', async () => {
    const request = plo4Cash(603, 'As Ks Qh Jh');
    const selected = await decideThrough(request, () => qualifiedPhase10TestAdmission(1));
    const reference = await decideThrough(request, undefined, true);
    expect(selected.h.decisionOpts[0].phase10Plo4).toBe('candidate');
    const receipt = selected.decision.plo4Policy!;
    expect(receipt).toMatchObject({
      mode: 'candidate',
      fired: true,
      changed: true,
      applied: true,
      selection: 'selected',
      utilityOwner: 'cash',
      authority: { state: 'usable', generation: 1, approvalGeneration: 1, mainGeneration: null },
    });
    // Selected = the proposal; shadow baseline = the reference the worker
    // would have executed without authority.
    expect(act(selected.decision)).toEqual({
      action: receipt.proposalAction,
      amount: receipt.proposalAmount,
    });
    expect({ action: receipt.baselineAction, amount: receipt.baselineAmount }).toEqual(
      act(reference.decision)
    );
    expect(act(selected.decision)).not.toEqual(act(reference.decision));
    expect(selected.result.phase10Authority).toEqual(receipt.authority);
    expect(horseDecisionReceiptIsValid(structuredClone(selected.decision), 'plo4')).toBe(true);
    // The worker boundary refuses the same selection without usable authority,
    // labelled as a tournament objective decision, or claiming acceptance.
    for (const forge of [
      (r: any) => (r.authority = { ...r.authority, state: 'refused' }),
      (r: any) => (r.authority = null),
      (r: any) => (r.authority = { ...r.authority, continuationVersion: 'plo4-policy-round1-v2' }),
      (r: any) => (r.utilityOwner = 'phase7_evaluated'),
      (r: any) => (r.selection = 'controller_accepted'),
      (r: any) => (r.authorityVerdict = 'usable'),
      (r: any) => (r.proposalAmount = 999),
      (r: any) => delete r.selection,
    ]) {
      const forged = structuredClone(selected.decision) as any;
      forge(forged.plo4Policy);
      expect(horseDecisionReceiptIsValid(forged, 'plo4')).toBe(false);
    }
  });

  it('tournament decisions keep Phase 7 ownership even when the pack would be selected', async () => {
    const admission = () => qualifiedPhase10TestAdmission(1);
    const cash = await decideThrough(plo4Cash(604, 'As Ks Qh Jh'), admission);
    expect(cash.h.decisionOpts[0].phase10Plo4).toBe('candidate');
    expect(cash.decision.plo4Policy?.selection).toBe('selected');

    const request = plo4Tournament(605, 'As Ks Qh Jh');
    const withAuthority = await decideThrough(request, admission);
    const withoutAuthority = await decideThrough(request);
    expect(withAuthority.result.phase10Authority?.state).toBe('usable');
    expect(withAuthority.h.decisionOpts[0].phase10Plo4).toBe('shadow');
    const receipt = withAuthority.decision.plo4Policy!;
    expect(receipt).toMatchObject({ mode: 'shadow', applied: false });
    expect(receipt.selection).not.toBe('selected');
    expect(receipt.utilityOwner).not.toBe('cash');
    // Identical to the decision made with no authority at all.
    expect(act(withAuthority.decision)).toEqual(act(withoutAuthority.decision));
    expect(withAuthority.decision.tournamentUtility ?? null).toEqual(
      withoutAuthority.decision.tournamentUtility ?? null
    );
    expect(withAuthority.decision.tournamentPreflopAttribution ?? null).toEqual(
      withoutAuthority.decision.tournamentPreflopAttribution ?? null
    );
    // A tournament receipt can never cross the boundary as a selection.
    const forged = structuredClone(withAuthority.decision) as any;
    Object.assign(forged.plo4Policy, {
      mode: 'candidate',
      applied: true,
      changed: true,
      selection: 'selected',
      finalAction: forged.plo4Policy.proposalAction,
      finalAmount: forged.plo4Policy.proposalAmount,
    });
    forged.action = forged.plo4Policy.proposalAction;
    forged.amount = forged.plo4Policy.proposalAmount ?? undefined;
    expect(horseDecisionReceiptIsValid(forged, 'plo4')).toBe(false);
  });

  it('a caller still cannot supply PLO4 candidate control when authority is usable', async () => {
    const h = harness(true);
    h.deps.admitPhase10Authority = () => qualifiedPhase10TestAdmission(1);
    h.runtime.receive({
      ...plo4Cash(606, 'As Ks Qh Jh'),
      opts: { phase10Plo4: 'candidate' },
    } as unknown as FastHorseDecisionRequest);
    await h.runtime.drain();
    expect(h.decisionOpts).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'offline candidate controls are forbidden in live decision requests',
    });
  });

  it('the caller may turn the pack off; deep think-time work admits afresh', async () => {
    const h = harness();
    h.deps.admitPhase10Authority = () => qualifiedPhase10TestAdmission(1);
    h.runtime.receive(rekey({ ...fastRequest(1), opts: { phase10Plo4: 'off' } }));
    const request = fastRequest(2);
    h.runtime.receive(request);
    await h.runtime.drain();
    const fast = h.messages.filter((m) => m.type === 'FAST_RESULT').at(-1);
    if (fast?.type !== 'FAST_RESULT') throw Error('expected FAST_RESULT');
    h.runtime.receive({
      ...request,
      type: 'DECIDE_DEEP',
      requestId: 3,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    expect(h.decisionOpts.map((o) => o.phase10Plo4)).toEqual(['off', 'candidate', 'candidate']);
    const deep = h.messages.find((m) => m.type === 'DEEP_RESULT');
    expect(deep?.type === 'DEEP_RESULT' && deep.phase10Authority?.state).toBe('usable');
  });
});

describe('P11.3 worker-owned PLO5/PLO6/PLO8 authority (the Phase 8 path, reused per pack)', () => {
  const omahaCash = (
    requestId: number,
    variant: OmahaPolicyVariant,
    cards: string
  ): FastHorseDecisionRequest =>
    rekey({
      ...fastRequest(requestId),
      player: { ...snapshot.player, cards: variantCards(cards) },
      gameState: {
        ...structuredClone(snapshot.gameState),
        gameVariant: variant,
        variantRules: horseVariantRulesFor(variant),
        dealerSeat: 2,
        // Heads-up the button posts the small blind (HandController's walk).
        blindSeats: { smallBlind: 2, bigBlind: 3 },
      },
      style: 'balanced',
      mods: {},
      opts: { mind: false },
    });
  const omahaTournament = (
    requestId: number,
    variant: OmahaPolicyVariant,
    cards: string
  ): FastHorseDecisionRequest => {
    const base = phase6TournamentRequest(requestId);
    return rekey({
      ...base,
      player: { ...snapshot.player, cards: variantCards(cards) },
      gameState: {
        ...base.gameState,
        gameVariant: variant,
        bettingStructure: 'pot_limit',
        variantRules: horseVariantRulesFor(variant),
        legalActions: snapshot.gameState.legalActions,
        minRaiseTo: snapshot.gameState.minRaiseTo,
        maxRaiseTo: snapshot.gameState.maxRaiseTo,
        // Heads-up the button (seat 2) posts the small blind.
        blindSeats: { smallBlind: 2, bigBlind: 3 },
        tournament: { ...base.gameState.tournament!, gameVariant: variant },
      },
      style: 'balanced',
      mods: {},
      opts: { mind: false },
    });
  };
  /** One real worker decision; HorseLogic's RNG is seeded identically for
   * every run, so two runs differ only by what the worker admitted. */
  async function decideThrough(
    request: FastHorseDecisionRequest,
    admission?: (variant: OmahaPolicyVariant) => HorseAuthorityAdmission,
    packOff = false
  ) {
    const h = harness(true);
    h.deps.admitPhase11Authority = admission;
    const decide = h.deps.decide;
    h.deps.decide = (player, gameState, style, mods, opts) => {
      const rng = saveFastRandom();
      seedFastRandom(10_301_104);
      try {
        return decide(
          player,
          gameState,
          style,
          mods,
          packOff ? { ...opts, phase11Omaha: 'off' } : opts
        );
      } finally {
        restoreFastRandom(rng);
      }
    };
    // Wiring, not latency: the 4 ms budget is tested by OmahaVariantLivePolicy.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      h.runtime.receive(request);
      await h.runtime.drain();
    } finally {
      clock.mockRestore();
    }
    const result = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(h.messages));
    return { h, result, decision: result.decision };
  }
  const act = (d: { action: string; amount?: number }) => ({
    action: d.action,
    amount: d.amount ?? null,
  });
  const only =
    (variant: OmahaPolicyVariant, approval = 1) =>
    (requested: OmahaPolicyVariant): HorseAuthorityAdmission =>
      requested === variant
        ? qualifiedPhase11TestAdmission(variant, approval)
        : { status: 'refused', reason: 'unselected', transient: false };

  // Actions pinned from the unmodified base (fb9c43ea, P11.1 merged with
  // P11.2): the packs are shadow there, so these are the reference actions
  // live tables execute. Read through this same harness and seed on that base
  // before any P11.3 change (docs/evidence/phase11/p11-3-pin-base.log).
  const LIVE_STATES = [
    ['plo5', 'cash', 'As Ad Ks Kd Qs', true, { action: 'raise', amount: 11 }],
    ['plo5', 'cash', 'Ah 7c 2s 3d 9h', false, { action: 'fold', amount: null }],
    ['plo5', 'cash', 'Qs Qh 4c 4d 8s', false, { action: 'fold', amount: null }],
    ['plo5', 'tournament', 'As Ad Ks Kd Qs', true, { action: 'raise', amount: 11 }],
    ['plo6', 'cash', 'As Ad Ks Kd Qs Jd', true, { action: 'raise', amount: 11 }],
    ['plo6', 'cash', 'Ah 7c 2s 3d 9h 5c', true, { action: 'fold', amount: null }],
    ['plo6', 'cash', 'Qs Qh 4c 4d 8s 9c', true, { action: 'call', amount: 2 }],
    ['plo6', 'tournament', 'As Ad Ks Kd Qs Jd', true, { action: 'raise', amount: 11 }],
    ['plo8', 'cash', 'As 2s 3d Ac', true, { action: 'raise', amount: 11 }],
    ['plo8', 'cash', 'Ah 7c Ks 9d', false, { action: 'fold', amount: null }],
    ['plo8', 'cash', 'Qs Qh 4c 4d', true, { action: 'call', amount: 2 }],
    ['plo8', 'tournament', 'As 2s 3d Ac', true, { action: 'raise', amount: 11 }],
  ] as const;

  it.each(LIVE_STATES)(
    'live behaviour is unchanged today: %s %s %s executes the same action as before P11.3',
    async (variant, format, cards, changed, baseAction) => {
      const request =
        format === 'cash' ? omahaCash(611, variant, cards) : omahaTournament(611, variant, cards);
      const live = await decideThrough(request, (v) => admitHorsePhase11ReleaseAuthority(v));
      const reference = await decideThrough(request, undefined, true);
      expect(live.h.decisionOpts[0].phase11Omaha).toBe('shadow');
      expect(act(live.decision)).toEqual(baseAction);
      expect(act(reference.decision)).toEqual(baseAction);
      expect(reference.decision.omahaVariantPolicy).toBeUndefined();
      const receipt = live.decision.omahaVariantPolicy!;
      expect(receipt).toMatchObject({
        variant,
        mode: 'shadow',
        eligible: true,
        applied: false,
        authorityVerdict: null,
        selectionRefusal: null,
        authority: {
          state: 'unselected',
          reason: 'unselected',
          authorityKey: null,
          continuationVersion: OMAHA_VARIANT_PACKS[variant].version,
        },
      });
      expect(receipt.changed).toBe(changed);
      expect(receipt.selection).toBe(changed ? 'shadow_change' : 'none');
      expect(receipt.finalAction).toBe(live.decision.action);
      for (const pack of ['plo5', 'plo6', 'plo8'] as const)
        expect(live.result.phase11Authority?.[pack]).toMatchObject({
          state: 'unselected',
          continuationVersion: OMAHA_VARIANT_PACKS[pack].version,
        });
      expect(horseDecisionReceiptIsValid(structuredClone(live.decision), variant)).toBe(true);
    }
  );

  it('a decision of another variant carries no Phase 11 authority', async () => {
    const live = await decideThrough(
      rekey({ ...fastRequest(612), style: 'balanced', mods: {}, opts: { mind: false } }),
      () => qualifiedPhase11TestAdmission('plo5')
    );
    expect(live.decision.omahaVariantPolicy).toBeUndefined();
    expect(live.h.decisionOpts[0].phase11Omaha).toBe('shadow');
    expect(live.result.phase11Authority?.plo5.state).toBe('usable');
  });

  const refused = (overrides: {
    qualification?: Record<string, unknown>;
    completion?: Record<string, unknown> | null;
  }) => {
    const q = p11QualificationBytes('plo6', overrides.qualification);
    const c =
      overrides.completion === null ? null : p11CompletionBytes('plo6', overrides.completion);
    return () =>
      admitHorsePhase11QualifiedAuthority(
        'plo6',
        p11Selection('plo6', q, c),
        p11Reader('plo6', q, c),
        P11_TEST_NOW,
        P11_TEST_CONTRACT_DIGEST
      );
  };
  it.each([
    ['qualified:false', refused({ qualification: { qualified: false } }), 'not_qualified'],
    ['wrong-source', refused({ qualification: { sourceSha: 'c'.repeat(40) } }), 'source_mismatch'],
    ['no-completion', refused({ completion: null }), 'completion_evidence_missing'],
    [
      'other-policy completion',
      refused({ completion: { policyDigest: 'd'.repeat(64) } }),
      'completion_release_mismatch',
    ],
    [
      'below-floor',
      refused({
        completion: {
          streets: { ...p11CompletionObject('plo6').streets, river: p11Street(200, 20) },
        },
      }),
      'completion_below_floor',
    ],
  ] as const)(
    'a %s PLO6 admission keeps the pack in shadow and the reference action',
    async (_name, admission, reason) => {
      const request = omahaCash(613, 'plo6', 'Ah 7c 2s 3d 9h 5c');
      const result = await decideThrough(request, (v) =>
        v === 'plo6' ? admission() : { status: 'refused', reason: 'unselected', transient: false }
      );
      const reference = await decideThrough(request, undefined, true);
      expect(result.h.decisionOpts[0].phase11Omaha).toBe('shadow');
      expect(act(result.decision)).toEqual(act(reference.decision));
      expect(result.decision.omahaVariantPolicy).toMatchObject({
        mode: 'shadow',
        changed: true,
        applied: false,
        selection: 'shadow_change',
        authority: { state: 'refused', reason },
      });
    }
  );

  it.each([
    ['plo5', 'As Ad Ks Kd Qs'],
    ['plo6', 'Ah 7c 2s 3d 9h 5c'],
    ['plo8', 'Qs Qh 4c 4d'],
  ] as const)(
    'a valid %s qualification and completion record (test fixture only) select the cash proposal and record selected and baseline actions',
    async (variant, cards) => {
      const request = omahaCash(614, variant, cards);
      const selected = await decideThrough(request, only(variant));
      const reference = await decideThrough(request, undefined, true);
      expect(selected.h.decisionOpts[0].phase11Omaha).toBe('candidate');
      const receipt = selected.decision.omahaVariantPolicy!;
      expect(receipt).toMatchObject({
        variant,
        mode: 'candidate',
        fired: true,
        changed: true,
        applied: true,
        selection: 'selected',
        selectionRefusal: null,
        utilityOwner: 'cash',
        authority: {
          state: 'usable',
          generation: 1,
          approvalGeneration: 1,
          mainGeneration: null,
          continuationVersion: OMAHA_VARIANT_PACKS[variant].version,
        },
      });
      // Selected = the proposal; shadow baseline = the reference the worker
      // would have executed without authority.
      expect(act(selected.decision)).toEqual({
        action: receipt.proposalAction,
        amount: receipt.proposalAmount,
      });
      expect({ action: receipt.baselineAction, amount: receipt.baselineAmount }).toEqual(
        act(reference.decision)
      );
      expect(act(selected.decision)).not.toEqual(act(reference.decision));
      expect(selected.result.phase11Authority?.[variant]).toEqual(receipt.authority);
      expect(horseDecisionReceiptIsValid(structuredClone(selected.decision), variant)).toBe(true);
      // The worker boundary refuses the same selection without usable
      // authority, with another pack's authority, labelled as a tournament
      // objective decision, or claiming acceptance.
      const otherPack = variant === 'plo5' ? 'plo6' : 'plo5';
      for (const forge of [
        (r: any) => (r.authority = { ...r.authority, state: 'refused' }),
        (r: any) => (r.authority = null),
        (r: any) =>
          (r.authority = {
            ...r.authority,
            continuationVersion: OMAHA_VARIANT_PACKS[otherPack].version,
          }),
        (r: any) =>
          (r.authority = { ...r.authority, continuationVersion: 'plo4-policy-round1-v3' }),
        (r: any) => (r.utilityOwner = 'phase7_evaluated'),
        (r: any) => (r.selection = 'controller_accepted'),
        (r: any) => (r.authorityVerdict = 'usable'),
        (r: any) => (r.selectionRefusal = 'retained'),
        (r: any) => (r.proposalAction = 'all_in'),
        (r: any) => delete r.selection,
      ]) {
        const forged = structuredClone(selected.decision) as any;
        forge(forged.omahaVariantPolicy);
        expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
      }
    }
  );

  it('a PLO5 selection never selects a PLO6 or PLO8 decision', async () => {
    const plo5 = await decideThrough(omahaCash(615, 'plo5', 'As Ad Ks Kd Qs'), only('plo5'));
    expect(plo5.h.decisionOpts[0].phase11Omaha).toBe('candidate');
    expect(plo5.decision.omahaVariantPolicy?.selection).toBe('selected');
    for (const [variant, cards] of [
      ['plo6', 'Ah 7c 2s 3d 9h 5c'],
      ['plo8', 'Qs Qh 4c 4d'],
    ] as const) {
      const other = await decideThrough(omahaCash(616, variant, cards), only('plo5'));
      expect(other.h.decisionOpts[0].phase11Omaha, variant).toBe('shadow');
      expect(other.result.phase11Authority?.plo5.state).toBe('usable');
      expect(other.decision.omahaVariantPolicy).toMatchObject({
        mode: 'shadow',
        applied: false,
        selection: 'shadow_change',
        authority: {
          state: 'unselected',
          continuationVersion: OMAHA_VARIANT_PACKS[variant].version,
        },
      });
      // Its receipt cannot borrow the usable PLO5 authority at the boundary.
      const forged = structuredClone(other.decision) as any;
      Object.assign(forged.omahaVariantPolicy, {
        mode: 'candidate',
        applied: true,
        selection: 'selected',
        authority: other.result.phase11Authority!.plo5,
        finalAction: forged.omahaVariantPolicy.proposalAction,
        finalAmount: forged.omahaVariantPolicy.proposalAmount,
      });
      forged.action = forged.omahaVariantPolicy.proposalAction;
      forged.amount = forged.omahaVariantPolicy.proposalAmount ?? undefined;
      expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
    }
  });

  it.each([
    ['plo5', 'As Ad Ks Kd Qs'],
    ['plo8', 'As 2s 3d Ac'],
  ] as const)(
    'a %s tournament decision keeps Phase 7 ownership even when the pack would be selected',
    async (variant, cards) => {
      const request = omahaTournament(617, variant, cards);
      const withAuthority = await decideThrough(request, only(variant));
      const withoutAuthority = await decideThrough(request);
      expect(withAuthority.result.phase11Authority?.[variant].state).toBe('usable');
      expect(withAuthority.h.decisionOpts[0].phase11Omaha).toBe('shadow');
      const receipt = withAuthority.decision.omahaVariantPolicy!;
      expect(receipt).toMatchObject({ mode: 'shadow', applied: false });
      expect(receipt.selection).not.toBe('selected');
      expect(receipt.utilityOwner).not.toBe('cash');
      // Identical to the decision made with no authority at all.
      expect(act(withAuthority.decision)).toEqual(act(withoutAuthority.decision));
      expect(withAuthority.decision.tournamentUtility ?? null).toEqual(
        withoutAuthority.decision.tournamentUtility ?? null
      );
      expect(withAuthority.decision.tournamentPreflopAttribution ?? null).toEqual(
        withoutAuthority.decision.tournamentPreflopAttribution ?? null
      );
      // A tournament receipt can never cross the boundary as a selection.
      const forged = structuredClone(withAuthority.decision) as any;
      Object.assign(forged.omahaVariantPolicy, {
        mode: 'candidate',
        applied: true,
        changed: true,
        selection: 'selected',
        finalAction: forged.omahaVariantPolicy.proposalAction,
        finalAmount: forged.omahaVariantPolicy.proposalAmount,
      });
      forged.action = forged.omahaVariantPolicy.proposalAction;
      forged.amount = forged.omahaVariantPolicy.proposalAmount ?? undefined;
      expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
    }
  );

  it('a caller still cannot supply Phase 11 candidate control when authority is usable', async () => {
    const h = harness(true);
    h.deps.admitPhase11Authority = only('plo5');
    h.runtime.receive({
      ...omahaCash(618, 'plo5', 'As Ad Ks Kd Qs'),
      opts: { phase11Omaha: 'candidate' },
    } as unknown as FastHorseDecisionRequest);
    await h.runtime.drain();
    expect(h.decisionOpts).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({
      type: 'ERROR',
      message: 'offline candidate controls are forbidden in live decision requests',
    });
  });

  it('the caller may turn the packs off; deep think-time work admits afresh', async () => {
    const h = harness();
    h.deps.admitPhase11Authority = only('plo8');
    const off = omahaCash(1, 'plo8', 'Qs Qh 4c 4d');
    h.runtime.receive(rekey({ ...off, opts: { phase11Omaha: 'off' } }));
    const request = omahaCash(2, 'plo8', 'Qs Qh 4c 4d');
    h.runtime.receive(request);
    await h.runtime.drain();
    const fast = h.messages.filter((m) => m.type === 'FAST_RESULT').at(-1);
    if (fast?.type !== 'FAST_RESULT') throw Error('expected FAST_RESULT');
    h.runtime.receive({
      ...request,
      type: 'DECIDE_DEEP',
      requestId: 3,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    expect(h.decisionOpts.map((o) => o.phase11Omaha)).toEqual(['off', 'candidate', 'candidate']);
    const deep = h.messages.find((m) => m.type === 'DEEP_RESULT');
    expect(deep?.type === 'DEEP_RESULT' && deep.phase11Authority?.plo8.state).toBe('usable');
    expect(deep?.type === 'DEEP_RESULT' && deep.phase11Authority?.plo5.state).toBe('unselected');
  });
});

describe('P12.3 worker-owned Short Deck/Pineapple/FLH/FLO8 authority (the Phase 8 path, reused per pack)', () => {
  type Street = 'preflop' | 'flop' | 'turn' | 'river';
  /** A canonical Phase 12 cash request through the live worker. */
  const remainingCash = (
    requestId: number,
    variant: RemainingPolicyVariant,
    street: Street,
    seats: number
  ): FastHorseDecisionRequest => {
    const s = remainingVariantSpot(variant, street, seats, 'cash');
    return rekey({
      ...fastRequest(requestId),
      player: s.hero,
      gameState: s.state,
      style: 'balanced',
      mods: {},
      opts: { mind: false },
    });
  };
  /** The same spot at a tournament table with a complete Phase 6 context. */
  const remainingTournament = (
    requestId: number,
    variant: RemainingPolicyVariant,
    street: Street,
    seats: number
  ): FastHorseDecisionRequest => {
    const s = remainingVariantSpot(variant, street, seats, 'tournament');
    const tournament = {
      ...phase6TournamentRequest(requestId).gameState.tournament!,
      ...s.state.tournament!,
      gameVariant: variant,
      playersAtTable: seats,
      nextAnte: 0,
    };
    tournament.m = buildTournamentMState({
      stackChips: s.hero.stack,
      smallBlind: tournament.currentSmallBlind!,
      bigBlind: tournament.currentBigBlind!,
      ante: tournament.currentAnte!,
      anteType: tournament.anteType!,
      playersAtTable: tournament.playersAtTable!,
      nextSmallBlind: tournament.nextSmallBlind ?? null,
      nextBigBlind: tournament.nextBigBlind ?? null,
      nextAnte: tournament.nextAnte ?? null,
      minutesToNextLevel: tournament.nextBlindInMin ?? null,
      opponentStacks: s.state.players
        .filter((p) => p.user_id !== s.hero.user_id)
        .map((p) => ({ userId: p.user_id, stackChips: p.stack })),
    });
    return rekey({
      ...fastRequest(requestId),
      player: s.hero,
      gameState: { ...s.state, format: 'mtt', tournament },
      style: 'balanced',
      mods: {},
      opts: { mind: false },
    });
  };
  /** One real worker decision; HorseLogic's RNG is seeded identically for
   * every run, so two runs differ only by what the worker admitted. */
  async function decideThrough(
    request: FastHorseDecisionRequest,
    admission?: (variant: RemainingPolicyVariant) => HorseAuthorityAdmission,
    packOff = false,
    seed = 10_301_204
  ) {
    const h = harness(true);
    h.deps.admitPhase12Authority = admission;
    const decide = h.deps.decide;
    h.deps.decide = (player, gameState, style, mods, opts) => {
      const rng = saveFastRandom();
      seedFastRandom(seed);
      try {
        return decide(
          player,
          gameState,
          style,
          mods,
          packOff ? { ...opts, phase12Remaining: 'off' } : opts
        );
      } finally {
        restoreFastRandom(rng);
      }
    };
    // Wiring, not latency: the 4 ms budget is tested by RemainingVariantLivePolicy.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      h.runtime.receive(request);
      await h.runtime.drain();
    } finally {
      clock.mockRestore();
    }
    const result = h.messages.find((m) => m.type === 'FAST_RESULT');
    if (result?.type !== 'FAST_RESULT') throw new Error(JSON.stringify(h.messages));
    return { h, result, decision: result.decision };
  }
  const act = (d: { action: string; amount?: number }) => ({
    action: d.action,
    amount: d.amount ?? null,
  });
  const only =
    (variant: RemainingPolicyVariant, approval = 1) =>
    (requested: RemainingPolicyVariant): HorseAuthorityAdmission =>
      requested === variant
        ? qualifiedPhase12TestAdmission(variant, approval)
        : { status: 'refused', reason: 'unselected', transient: false };
  const request = (
    format: 'cash' | 'tournament',
    variant: RemainingPolicyVariant,
    street: Street,
    seats: number,
    requestId = 621
  ) =>
    format === 'cash'
      ? remainingCash(requestId, variant, street, seats)
      : remainingTournament(requestId, variant, street, seats);

  // Actions pinned from the unmodified base (4fe703f8: P12.1 merged with
  // P12.2 and the integration fix): the packs are shadow there, so these are
  // the reference actions live tables execute. Read through this same harness
  // and seed on that base before any P12.3 change
  // (docs/evidence/phase12/p12-3-pin-base.log).
  const LIVE_STATES = [
    ['short_deck', 'cash', 'preflop', 3, 10_301_204, true, true, { action: 'raise', amount: 4 }],
    ['short_deck', 'cash', 'river', 2, 10_301_204, true, false, { action: 'call', amount: 20 }],
    ['short_deck', 'tournament', 'flop', 2, 100_101, true, true, { action: 'raise', amount: 100 }],
    ['pineapple', 'cash', 'turn', 2, 10_301_204, true, true, { action: 'raise', amount: 80 }],
    ['pineapple', 'cash', 'flop', 3, 10_301_204, true, false, { action: 'call', amount: 20 }],
    [
      'pineapple',
      'tournament',
      'turn',
      2,
      10_301_204,
      false,
      false,
      { action: 'raise', amount: 80 },
    ],
    ['flh', 'cash', 'turn', 3, 10_301_204, true, true, { action: 'raise', amount: 8 }],
    ['flh', 'cash', 'preflop', 2, 10_301_204, true, false, { action: 'raise', amount: 4 }],
    ['flh', 'tournament', 'river', 2, 4040, true, true, { action: 'call', amount: 4 }],
    ['flo8', 'cash', 'flop', 2, 100_101, true, true, { action: 'call', amount: 2 }],
    ['flo8', 'cash', 'river', 3, 10_301_204, true, false, { action: 'call', amount: 4 }],
    ['flo8', 'tournament', 'turn', 2, 4040, true, true, { action: 'raise', amount: 8 }],
  ] as const;
  /** Cash spots where the pack's proposal differs from the reference. */
  const CHANGED_CASH = {
    short_deck: ['flop', 2, 100_101],
    pineapple: ['turn', 2, 10_301_204],
    flh: ['turn', 3, 10_301_204],
    flo8: ['flop', 2, 100_101],
  } as const satisfies Record<RemainingPolicyVariant, readonly [Street, number, number]>;
  const changedCash = (requestId: number, variant: RemainingPolicyVariant) =>
    remainingCash(requestId, variant, CHANGED_CASH[variant][0], CHANGED_CASH[variant][1]);
  const seedOf = (variant: RemainingPolicyVariant) => CHANGED_CASH[variant][2];
  /** Tournament spots where the pack's proposal differs from the reference. */
  const CHANGED_TOURNAMENT = [
    ['short_deck', 'flop', 2, 100_101],
    ['flh', 'turn', 3, 10_301_204],
    ['flo8', 'flop', 2, 100_101],
  ] as const;

  it.each(LIVE_STATES)(
    'live behaviour is unchanged today: %s %s %s with %i seats (seed %i) executes the same action as before P12.3',
    async (variant, format, street, seats, seed, eligible, changed, baseAction) => {
      const r = request(format, variant, street, seats);
      const live = await decideThrough(r, (v) => admitHorsePhase12ReleaseAuthority(v), false, seed);
      const reference = await decideThrough(r, undefined, true, seed);
      expect(live.h.decisionOpts[0].phase12Remaining).toBe('shadow');
      expect(act(live.decision)).toEqual(baseAction);
      expect(act(reference.decision)).toEqual(baseAction);
      expect(reference.decision.remainingVariantPolicy).toBeUndefined();
      const receipt = live.decision.remainingVariantPolicy!;
      expect(receipt).toMatchObject({
        variant,
        mode: 'shadow',
        eligible,
        applied: false,
        authorityVerdict: null,
        selectionRefusal: null,
        authority: {
          state: 'unselected',
          reason: 'unselected',
          authorityKey: null,
          continuationVersion: REMAINING_VARIANT_PACKS[variant].version,
        },
      });
      expect(receipt.changed).toBe(changed);
      expect(receipt.selection).toBe(changed ? 'shadow_change' : 'none');
      expect(receipt.finalAction).toBe(live.decision.action);
      for (const pack of ['short_deck', 'pineapple', 'flh', 'flo8'] as const)
        expect(live.result.phase12Authority?.[pack]).toMatchObject({
          state: 'unselected',
          continuationVersion: REMAINING_VARIANT_PACKS[pack].version,
        });
      expect(horseDecisionReceiptIsValid(structuredClone(live.decision), variant)).toBe(true);
    }
  );

  it('a decision of another variant carries no Phase 12 authority', async () => {
    const live = await decideThrough(
      rekey({ ...fastRequest(622), style: 'balanced', mods: {}, opts: { mind: false } }),
      () => qualifiedPhase12TestAdmission('flh')
    );
    expect(live.decision.remainingVariantPolicy).toBeUndefined();
    expect(live.h.decisionOpts[0].phase12Remaining).toBe('shadow');
    expect(live.result.phase12Authority?.flh.state).toBe('usable');
  });

  const refused = (overrides: {
    qualification?: Record<string, unknown>;
    completion?: Record<string, unknown> | null;
  }) => {
    const q = p12QualificationBytes('flh', overrides.qualification);
    const c =
      overrides.completion === null ? null : p12CompletionBytes('flh', overrides.completion);
    return () =>
      admitHorsePhase12QualifiedAuthority(
        'flh',
        p12Selection('flh', q, c),
        p12Reader('flh', q, c),
        P12_TEST_NOW,
        P12_TEST_CONTRACT_DIGEST
      );
  };
  it.each([
    ['qualified:false', refused({ qualification: { qualified: false } }), 'not_qualified'],
    ['wrong-source', refused({ qualification: { sourceSha: 'c'.repeat(40) } }), 'source_mismatch'],
    ['no-completion', refused({ completion: null }), 'completion_evidence_missing'],
    [
      'other-policy completion',
      refused({ completion: { policyDigest: 'd'.repeat(64) } }),
      'completion_release_mismatch',
    ],
    [
      'governor-reduced',
      refused({
        completion: {
          streets: { ...p12CompletionObject('flh').streets, river: p12Street(200, 0, 0, 0, 20) },
        },
      }),
      'completion_below_floor',
    ],
  ] as const)(
    'a %s FLH admission keeps the pack in shadow and the reference action',
    async (_name, admission, reason) => {
      const r = changedCash(623, 'flh');
      const result = await decideThrough(
        r,
        (v) =>
          v === 'flh' ? admission() : { status: 'refused', reason: 'unselected', transient: false },
        false,
        seedOf('flh')
      );
      const reference = await decideThrough(r, undefined, true, seedOf('flh'));
      expect(result.h.decisionOpts[0].phase12Remaining).toBe('shadow');
      expect(act(result.decision)).toEqual(act(reference.decision));
      expect(result.decision.remainingVariantPolicy).toMatchObject({
        mode: 'shadow',
        changed: true,
        applied: false,
        selection: 'shadow_change',
        authority: { state: 'refused', reason },
      });
    }
  );

  it.each(['short_deck', 'pineapple', 'flh', 'flo8'] as const)(
    'a valid %s qualification and completion record (test fixture only) select the cash proposal and record selected and baseline actions',
    async (variant) => {
      const r = changedCash(624, variant);
      const selected = await decideThrough(r, only(variant), false, seedOf(variant));
      const reference = await decideThrough(r, undefined, true, seedOf(variant));
      expect(selected.h.decisionOpts[0].phase12Remaining).toBe('candidate');
      const receipt = selected.decision.remainingVariantPolicy!;
      expect(receipt).toMatchObject({
        variant,
        mode: 'candidate',
        fired: true,
        changed: true,
        applied: true,
        selection: 'selected',
        selectionRefusal: null,
        utilityOwner: 'cash',
        authority: {
          state: 'usable',
          generation: 1,
          approvalGeneration: 1,
          mainGeneration: null,
          continuationVersion: REMAINING_VARIANT_PACKS[variant].version,
        },
      });
      // Selected = the proposal; shadow baseline = the reference the worker
      // would have executed without authority.
      expect(act(selected.decision)).toEqual({
        action: receipt.proposalAction,
        amount: receipt.proposalAmount,
      });
      expect({ action: receipt.baselineAction, amount: receipt.baselineAmount }).toEqual(
        act(reference.decision)
      );
      expect(act(selected.decision)).not.toEqual(act(reference.decision));
      expect(selected.result.phase12Authority?.[variant]).toEqual(receipt.authority);
      expect(horseDecisionReceiptIsValid(structuredClone(selected.decision), variant)).toBe(true);
      // The worker boundary refuses the same selection without usable
      // authority, with another pack's or a Phase 11 pack's authority,
      // labelled as a tournament objective decision, or claiming acceptance.
      const otherPack = variant === 'flh' ? 'flo8' : 'flh';
      for (const forge of [
        (r: any) => (r.authority = { ...r.authority, state: 'refused' }),
        (r: any) => (r.authority = null),
        (r: any) =>
          (r.authority = {
            ...r.authority,
            continuationVersion: REMAINING_VARIANT_PACKS[otherPack].version,
          }),
        (r: any) =>
          (r.authority = { ...r.authority, continuationVersion: OMAHA_VARIANT_PACKS.plo8.version }),
        (r: any) => (r.utilityOwner = 'phase7_evaluated'),
        (r: any) => (r.selection = 'controller_accepted'),
        (r: any) => (r.authorityVerdict = 'usable'),
        (r: any) => (r.selectionRefusal = 'retained'),
        (r: any) => (r.proposalAction = 'all_in'),
        (r: any) => delete r.selection,
      ]) {
        const forged = structuredClone(selected.decision) as any;
        forge(forged.remainingVariantPolicy);
        expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
      }
    }
  );

  it('a Short Deck selection never selects a Pineapple, FLH or FLO8 decision', async () => {
    const shortDeck = await decideThrough(
      changedCash(625, 'short_deck'),
      only('short_deck'),
      false,
      seedOf('short_deck')
    );
    expect(shortDeck.h.decisionOpts[0].phase12Remaining).toBe('candidate');
    expect(shortDeck.decision.remainingVariantPolicy?.selection).toBe('selected');
    for (const variant of ['pineapple', 'flh', 'flo8'] as const) {
      const other = await decideThrough(
        changedCash(626, variant),
        only('short_deck'),
        false,
        seedOf(variant)
      );
      expect(other.h.decisionOpts[0].phase12Remaining, variant).toBe('shadow');
      expect(other.result.phase12Authority?.short_deck.state).toBe('usable');
      expect(other.decision.remainingVariantPolicy).toMatchObject({
        mode: 'shadow',
        applied: false,
        selection: 'shadow_change',
        authority: {
          state: 'unselected',
          continuationVersion: REMAINING_VARIANT_PACKS[variant].version,
        },
      });
      // Its receipt cannot borrow the usable Short Deck authority at the boundary.
      const forged = structuredClone(other.decision) as any;
      Object.assign(forged.remainingVariantPolicy, {
        mode: 'candidate',
        applied: true,
        selection: 'selected',
        authority: other.result.phase12Authority!.short_deck,
        finalAction: forged.remainingVariantPolicy.proposalAction,
        finalAmount: forged.remainingVariantPolicy.proposalAmount,
      });
      forged.action = forged.remainingVariantPolicy.proposalAction;
      forged.amount = forged.remainingVariantPolicy.proposalAmount ?? undefined;
      expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
    }
  });

  it.each(CHANGED_TOURNAMENT)(
    'a %s %s tournament decision with %i seats (seed %i) keeps Phase 7 ownership even when the pack would be selected',
    async (variant, street, seats, seed) => {
      const r = remainingTournament(627, variant, street, seats);
      const withAuthority = await decideThrough(r, only(variant), false, seed);
      const withoutAuthority = await decideThrough(r, undefined, false, seed);
      expect(withAuthority.result.phase12Authority?.[variant].state).toBe('usable');
      expect(withAuthority.h.decisionOpts[0].phase12Remaining).toBe('shadow');
      const receipt = withAuthority.decision.remainingVariantPolicy!;
      expect(receipt).toMatchObject({ mode: 'shadow', applied: false, changed: true });
      expect(receipt.selection).not.toBe('selected');
      expect(receipt.utilityOwner).not.toBe('cash');
      // Identical to the decision made with no authority at all.
      expect(act(withAuthority.decision)).toEqual(act(withoutAuthority.decision));
      expect(withAuthority.decision.tournamentUtility ?? null).toEqual(
        withoutAuthority.decision.tournamentUtility ?? null
      );
      expect(withAuthority.decision.tournamentPreflopAttribution ?? null).toEqual(
        withoutAuthority.decision.tournamentPreflopAttribution ?? null
      );
      // A tournament receipt can never cross the boundary as a selection.
      const forged = structuredClone(withAuthority.decision) as any;
      Object.assign(forged.remainingVariantPolicy, {
        mode: 'candidate',
        applied: true,
        changed: true,
        selection: 'selected',
        finalAction: forged.remainingVariantPolicy.proposalAction,
        finalAmount: forged.remainingVariantPolicy.proposalAmount,
      });
      forged.action = forged.remainingVariantPolicy.proposalAction;
      forged.amount = forged.remainingVariantPolicy.proposalAmount ?? undefined;
      expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
    }
  );

  it('a Pineapple tournament decision stays refused by name under usable Pineapple authority', async () => {
    const r = remainingTournament(628, 'pineapple', 'flop', 2);
    const withAuthority = await decideThrough(r, only('pineapple'));
    const withoutAuthority = await decideThrough(r);
    expect(withAuthority.h.decisionOpts[0].phase12Remaining).toBe('shadow');
    expect(withAuthority.decision.remainingVariantPolicy).toMatchObject({
      reason: 'pineapple_tournament_unapproved',
      eligible: false,
      applied: false,
      selection: 'none',
      authority: { state: 'usable' },
    });
    expect(act(withAuthority.decision)).toEqual(act(withoutAuthority.decision));
  });

  it.each([{ phase12Remaining: 'candidate' }, { phase12EvidenceMode: true }])(
    'a caller still cannot supply Phase 12 candidate control when authority is usable: %j',
    async (opts) => {
      const h = harness(true);
      h.deps.admitPhase12Authority = only('flh');
      h.runtime.receive({
        ...changedCash(629, 'flh'),
        opts,
      } as unknown as FastHorseDecisionRequest);
      await h.runtime.drain();
      expect(h.decisionOpts).toEqual([]);
      expect(h.messages.at(-1)).toMatchObject({
        type: 'ERROR',
        message: 'offline candidate controls are forbidden in live decision requests',
      });
    }
  );

  it('the caller may turn the packs off; deep think-time work admits afresh', async () => {
    const h = harness();
    h.deps.admitPhase12Authority = only('flo8');
    const off = changedCash(1, 'flo8');
    h.runtime.receive(rekey({ ...off, opts: { phase12Remaining: 'off' } }));
    const r = changedCash(2, 'flo8');
    h.runtime.receive(r);
    await h.runtime.drain();
    const fast = h.messages.filter((m) => m.type === 'FAST_RESULT').at(-1);
    if (fast?.type !== 'FAST_RESULT') throw Error('expected FAST_RESULT');
    h.runtime.receive({
      ...r,
      type: 'DECIDE_DEEP',
      requestId: 3,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    expect(h.decisionOpts.map((o) => o.phase12Remaining)).toEqual([
      'off',
      'candidate',
      'candidate',
    ]);
    const deep = h.messages.find((m) => m.type === 'DEEP_RESULT');
    expect(deep?.type === 'DEEP_RESULT' && deep.phase12Authority?.flo8.state).toBe('usable');
    expect(deep?.type === 'DEEP_RESULT' && deep.phase12Authority?.flh.state).toBe('unselected');
    // Phase 11 holders are untouched by a Phase 12 selection.
    expect(deep?.type === 'DEEP_RESULT' && deep.phase11Authority?.plo8.state).toBe('unselected');
  });
});
