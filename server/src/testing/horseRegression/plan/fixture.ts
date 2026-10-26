import { horseVariantRulesFor } from '../../../engine/VariantRules.js';
import { bettingStructureFor } from '../../../engine/BettingStructure.js';
import { captureHorseHandJournalContext } from '../../../engine/HorseDecisionHandBinding.js';
import {
  horseObserverReadContextFromRequest,
  horseObserverReadContextKey,
} from '../../../engine/HorseObserverReadContext.js';
import type { HorseMindSandbox } from '../../../engine/HorseMind.js';
import { HorseMind } from '../../../engine/HorseMind.js';
import { HorseLogic } from '../../../engine/HorseLogic.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from '../../../engine/HorsePolicyGraph.js';
import { horsePlanHandKey } from '../../../engine/HorseDecisionEffects.js';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies as defaults,
  type HorseDecisionWorkerDependencies,
} from '../../../engine/horseDecision/workerRuntime.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type FastHorseDecisionResult,
  type HorseDecisionWorkerResponse,
  type HorseDecisionWorkerReadiness,
  type CommitDecisionEffectsRequest,
} from '../../../engine/horseDecision/protocol.js';
import type { ActionRecord, SeatPlayer, HorseDecision } from '../../../types.js';
import {
  horsePlanAcceptanceFromController,
  type HorsePlanAcceptance,
} from '../../../engine/HorsePlanEffectReceipt.js';
export const heroId = '11111111-1111-4111-8111-111111111111';
export const opponentId = '22222222-2222-4222-8222-222222222222';
export const tableId = '33333333-3333-4333-8333-333333333333';
export const otherTableId = '66666666-6666-4666-8666-666666666666';
export const lease = '44444444-4444-4444-8444-444444444444';
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
export function decisionRequest(): FastHorseDecisionRequest {
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
  request.handJournalContext = captureHorseHandJournalContext(request.gameState.actionHistory!);
  request.decisionKey = buildHorseDecisionKey(request);
  return request;
}

export function requestAt(
  requestId = 1,
  table = tableId,
  hand = 1000100
): FastHorseDecisionRequest {
  const request = decisionRequest();
  request.requestId = requestId;
  request.fence = `${table}:${hand}:1:${lease}:${request.generation}`;
  request.handJournalContext = captureHorseHandJournalContext(request.gameState.actionHistory!);
  request.decisionKey = buildHorseDecisionKey(request);
  return request;
}
export function wager(action: HorseDecision['action'] = 'bet', amount = 6): HorseDecision {
  const graph = new HorsePolicyGraph(() => 0);
  let decision: HorseDecision | null = null;
  for (const node of HORSE_POLICY_ORDER)
    decision = graph.run(node, decision, () => ({
      decision: { action, amount, thinkTime: 0 },
    })).decision;
  return graph.finish(decision!);
}
const readiness: HorseDecisionWorkerReadiness = {
  solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
  solverPolicyArtifact: {
    totalPolicies: 0,
  } as HorseDecisionWorkerReadiness['solverPolicyArtifact'],
  governor: {
    enabled: false,
    scale: 1,
    p50Ms: 0,
    p99Ms: 0,
    sampledAt: 0,
    throttledForS: 0,
    stale: false,
    timerLateMs: 0,
  },
};
export function workerHarness(
  overrides: Partial<HorseDecisionWorkerDependencies> = {},
  send?: (m: HorseDecisionWorkerResponse) => void
) {
  let clock = 100;
  let applied = 0;
  const messages: HorseDecisionWorkerResponse[] = [];
  const captures: Array<Record<string, unknown>> = [];
  const deps: HorseDecisionWorkerDependencies = {
    ...defaults,
    startServices: async () => readiness,
    stopServices: async () => {},
    journalEnabled: () => true,
    journalDecision: (_request, capture) => {
      captures.push(capture as Record<string, unknown>);
    },
    journalLifecycle: undefined,
    journalExecution: undefined,
    journalAcceptedHand: undefined,
    journalDiscard: undefined,
    journalDiscardExecution: undefined,
    workerReadiness: () => readiness,
    governorScale: () => 1,
    noteFeature: () => {},
    noteDecision: () => {},
    now: () => clock,
    decide: (player, gs, _style, _mods, opts) => {
      const key = horsePlanHandKey(gs.actionHistory, opts?.mindPlanContext);
      HorseMind.notePlan(key, player.user_id, true);
      HorseMind.noteRaisePlan(key, player.user_id, gs.stage, 'foldToRaise');
      HorseMind.noteOutlook(key, player.user_id, gs.stage, ['Ah'], ['Ks']);
      return wager();
    },
    applyDecisionEffects: (effects) => {
      applied++;
      HorseMind.applyDecisionEffects(effects);
    },
    ...overrides,
  };
  const runtime = new HorseDecisionWorkerRuntime((message) => {
    messages.push(message);
    send?.(message);
  }, deps);
  return {
    runtime,
    inspect: <T>(fn: () => T, request = requestAt()) => inspectObserverReads(runtime, request, fn),
    messages,
    captures,
    deps,
    applied: () => applied,
    advance: (ms: number) => {
      clock += ms;
    },
    async fast(request = requestAt()) {
      runtime.receive(structuredClone(request));
      await runtime.drain();
      const result = [...messages]
        .reverse()
        .find(
          (m): m is FastHorseDecisionResult =>
            m.type === 'FAST_RESULT' && m.requestId === request.requestId
        );
      if (!result) throw Error('Missing FAST result: ' + JSON.stringify(messages));
      return result;
    },
    async close() {
      runtime.receive({ type: 'SHUTDOWN' });
      await runtime.drain();
    },
  };
}
export function commitOf(
  result: FastHorseDecisionResult,
  requestId: number
): CommitDecisionEffectsRequest {
  return {
    type: 'COMMIT_DECISION_EFFECTS',
    requestId,
    generation: result.generation,
    fence: result.fence,
    planBinding: structuredClone(result.planBinding),
    effects: structuredClone(result.effects),
    acceptance: acceptanceOf(result),
  };
}
/** The exact wager a controller accepting this FAST decision records. */
export function acceptanceOf(result: FastHorseDecisionResult): HorsePlanAcceptance {
  return horsePlanAcceptanceFromController(
    null,
    { action: result.decision.action, amount: result.decision.amount ?? null },
    { requestId: result.requestId, decisionKey: result.planBinding.decisionKey }
  );
}

/** Inspect the actual private materialization without advancing its cutoff or
 * registering a synthetic FAST. Production has no public read/export API. */
export function inspectObserverReads<T>(
  runtime: HorseDecisionWorkerRuntime,
  request: FastHorseDecisionRequest,
  fn: () => T
): T {
  const key = horseObserverReadContextKey(horseObserverReadContextFromRequest(request));
  const entries = (
    runtime as unknown as { observerReads: { entries: Map<string, { state: HorseMindSandbox }> } }
  ).observerReads.entries;
  const entry = key ? entries.get(key) : undefined;
  if (!entry) throw Error('Expected original observer materialization');
  return HorseMind.runInSandbox(entry.state, fn);
}

/** Synthetic original participant FAST for completed-public-history fixtures.
 * It exercises actual worker admission; it does not claim DB/natural-use proof. */
export async function registerPublicObserver(
  runtime: HorseDecisionWorkerRuntime,
  completion: import('../../../engine/horseDecision/protocol.js').ObserveCompletedHandRequest,
  observer: string,
  players: SeatPlayer[],
  variant: NonNullable<FastHorseDecisionRequest['gameState']['gameVariant']> = 'nlh',
  format: 'cash' | 'mtt' = 'cash'
) {
  const request = decisionRequest();
  const parts = completion.handKey.split(':');
  const actor = players.find((p) => p.user_id === observer)!;
  request.requestId = 100000 + completion.requestId;
  request.generation = Number(parts[1]);
  request.fence = `${parts[0]}:${parts[1]}:${actor.seat}:${completion.fence.split(':')[2]}:${request.generation}`;
  request.decisionTimeMs = Date.now() + completion.requestId + 1000;
  request.player = { ...request.player, user_id: observer, seat: actor.seat };
  request.gameState = {
    ...request.gameState,
    players: players.map((p) => ({
      ...request.player,
      user_id: p.user_id,
      seat: p.seat,
      cards: [],
    })),
    dealtSeatIds: players.map((p) => p.seat),
    heroSeat: actor.seat,
    currentPlayerSeat: actor.seat,
    gameVariant: variant,
    gameMode: format === 'cash' ? 'cash' : 'tournament',
    format,
    actionHistory: [],
    stage: 'preflop',
    communityCards: [],
    pot: 3,
    currentBet: 0,
  };
  request.gameState.variantRules = horseVariantRulesFor(variant);
  request.player.cards = (
    [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'hearts' },
      { rank: 'Q', suit: 'diamonds' },
      { rank: 'J', suit: 'diamonds' },
      { rank: 'T', suit: 'diamonds' },
      { rank: '9', suit: 'diamonds' },
    ] as SeatPlayer['cards']
  ).slice(0, request.gameState.variantRules.holeCardsDealt);
  request.gameState.bettingStructure = bettingStructureFor(variant);
  request.gameState.fixedBetSize = request.gameState.bettingStructure === 'fixed_limit' ? 2 : null;
  request.gameState.pot = 12;
  request.gameState.pots = [{ amount: 12, eligiblePlayers: players.map((p) => p.user_id) }];
  request.handJournalContext = captureHorseHandJournalContext([]);
  request.decisionKey = buildHorseDecisionKey(request);
  (runtime as unknown as { assertEnvelope(r: FastHorseDecisionRequest): void }).assertEnvelope(
    request
  );
  runtime.receive(request);
  await runtime.drain();
  return request;
}
