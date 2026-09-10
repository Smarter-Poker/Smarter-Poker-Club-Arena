import { describe, expect, it } from 'vitest';

import type {
  HorseDecisionWorkerReady,
  HorseDecisionWorkerResponse,
} from './horseDecision/index.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import { HorseLogic } from './HorseLogic.js';
import { restoreFastRandom, saveFastRandom } from './HorseEval.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from './horseDecision/workerRuntime.js';
import { buildHorseDecisionKey, type FastHorseDecisionRequest } from './horseDecision/protocol.js';
import type { ActionRecord, Card, SeatPlayer } from '../types.js';

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });

const publicSeat = (
  seat: number,
  totalInvested: number,
  overrides: Partial<SeatPlayer> = {}
): SeatPlayer => ({
  seat,
  user_id: `horse-${seat}`,
  username: `Horse ${seat}`,
  stack: 1_000,
  bet: totalInvested,
  totalInvested,
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  ...overrides,
  // The public snapshot never carries any seat's cards, including hero's.
  cards: [],
});

const action = (
  seat: number,
  verb: ActionRecord['action'],
  amount: number,
  timestamp: number,
  isFullRaise?: boolean
): ActionRecord => ({
  seat,
  userId: `horse-${seat}`,
  action: verb,
  amount,
  timestamp,
  stage: 'turn',
  isFullRaise,
});

function t8Snapshot(v20Multiway = true): FastHorseDecisionRequest {
  const player: SeatPlayer = {
    ...publicSeat(1, 0),
    stack: 1_000,
    bet: 0,
    totalInvested: 0,
    cards: [card('T', 'diamonds'), card('8', 'clubs')],
  };
  const gameState = {
    stateSchemaVersion: 1,
    heroSeat: 1,
    currentPlayerSeat: 1,
    legalActions: ['fold', 'all_in'],
    toCall: 1_000,
    minRaiseTo: null,
    maxRaiseTo: null,
    bettingStructure: 'no_limit',
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
    players: [
      publicSeat(1, 0, { stack: 1_000, bet: 0 }),
      publicSeat(2, 60, { is_folded: true }),
      publicSeat(3, 950, { stack: 0, is_all_in: true }),
      publicSeat(4, 1_000, { stack: 0, is_all_in: true }),
      publicSeat(5, 150, { is_folded: true }),
      publicSeat(6, 150, { is_folded: true }),
    ],
    communityCards: [
      card('7', 'spades'),
      card('7', 'hearts'),
      card('9', 'diamonds'),
      card('8', 'hearts'),
    ],
    communityCards2: [],
    communityCards3: [],
    boardCount: 1,
    pot: 2_310,
    // Hero may match every current layer; this excludes hero's uncommitted call.
    contestablePot: 2_310,
    currentBet: 1_000,
    minRaise: 800,
    lastRaise: 800,
    stage: 'turn',
    gameVariant: 'nlh',
    bigBlind: 5,
    dealerSeat: 6,
    gameMode: 'cash',
    actionHistory: [
      action(3, 'check', 0, 1),
      action(2, 'bet', 60, 2),
      action(3, 'all_in', 950, 3, true),
      action(4, 'all_in', 1_000, 4, true),
      action(2, 'fold', 0, 5),
    ],
    pots: [
      { amount: 2_260, eligiblePlayers: ['horse-3', 'horse-4'] },
      { amount: 50, eligiblePlayers: ['horse-4'] },
    ],
    rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
    variantRules: {
      holeCardsDealt: 2,
      holeCardsUse: 'any',
      boardCardsUse: 'any',
      deckSize: 52,
      splitLow8OrBetter: false,
    },
  } as HorseGameStateV2;

  const request: FastHorseDecisionRequest = {
    type: 'DECIDE_FAST',
    requestId: v20Multiway ? 1 : 2,
    generation: 1,
    fence: `table:t8:turn:${v20Multiway ? 'enabled' : 'disabled'}`,
    decisionKey: '',
    decisionTimeMs: 3_600_000,
    player,
    gameState,
    style: 'balanced',
    mods: {},
    opts: { mind: false, v20Multiway },
  };
  request.decisionKey = buildHorseDecisionKey(request);
  return request;
}

function workerHarness() {
  const messages: HorseDecisionWorkerResponse[] = [];
  const governor = {
    enabled: true,
    scale: 1,
    p50Ms: 0,
    p99Ms: 0,
    sampledAt: 1,
    throttledForS: 0,
    stale: false,
    timerLateMs: 0,
  };
  const readiness = {
    solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
    solverPolicyArtifact: { totalPolicies: 0 } as HorseDecisionWorkerReady['solverPolicyArtifact'],
    governor,
  };
  const deps: HorseDecisionWorkerDependencies = {
    startServices: async () => readiness,
    stopServices: async () => undefined,
    decide: HorseLogic.decide.bind(HorseLogic),
    decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
    captureDecisionEffects: (fn) => ({ value: fn(), effects: [] }),
    applyDecisionEffects: () => undefined,
    saveRng: saveFastRandom,
    restoreRng: restoreFastRandom,
    governorScale: () => 1,
    workerReadiness: () => readiness,
    observeCompletedHand: () => undefined,
    noteDecision: () => undefined,
    noteFeature: () => undefined,
    now: () => 1,
  };
  return {
    messages,
    runtime: new HorseDecisionWorkerRuntime((message) => messages.push(message), deps),
  };
}

describe('Phase 5 live worker catastrophe corpus', () => {
  it('carries the reported T8o multiway all-in state through the worker and folds it', async () => {
    const enabled = workerHarness();
    enabled.runtime.receive(t8Snapshot(true));
    await enabled.runtime.drain();
    expect(enabled.messages.at(-1)).toMatchObject({
      type: 'FAST_RESULT',
      requestId: 1,
      decision: { action: 'fold' },
    });

    const disabled = workerHarness();
    disabled.runtime.receive(t8Snapshot(false));
    await disabled.runtime.drain();
    expect(disabled.messages.at(-1)).toMatchObject({ type: 'FAST_RESULT', requestId: 2 });
    expect(
      (disabled.messages.at(-1) as { decision?: { action?: string } }).decision?.action
    ).not.toBe('fold');
  });
});
