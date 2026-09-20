import type { HorseDecision, HorseTournamentUtilityCandidateLedger, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import { scoreHoldem } from './HorseEval.js';
import {
  evaluateTournamentUtilityDetailed,
  selectContinuationSamples,
  type TournamentUtilityInput,
  type TournamentContinuationRunner,
  type TournamentContinuationWork,
} from './HorseTournamentUtility.js';
import {
  projectTournamentFutureGame,
  type TournamentFutureGame,
} from './HorseTournamentFutureGame.js';
import { CONTINUATION_POLICY } from './HorseTournamentContinuation.js';
import { FUTURE_HAND_POLICY } from './HorseTournamentFutureHand.js';

export const PHASE8_POLICY = {
  version: 'horse-tournament-postflop-round1-v4',
  defaultMode: 'shadow',
  deepStackBB: 200,
  deepCommitFraction: 0.25,
  bluffEquityCeiling: 0.5,
  lowSpr: 1,
  maxCandidates: 16,
  maxFutureOutcomeSamples: 16,
  maxFutureIcmTrials: FUTURE_HAND_POLICY.maxIcmTrials,
  policyBudgetMs: 2,
  budgetMs: 5,
  workBudgetMs: 4,
} as const;
export type Phase8Mode = 'off' | 'shadow' | 'candidate';
export interface HorseTournamentPostflopLedger {
  version: typeof PHASE8_POLICY.version;
  mode: Exclude<Phase8Mode, 'off'>;
  eligible: boolean;
  fired: boolean;
  /** A useful continuation survived final policy/wall gates; not executor acceptance. */
  completed: boolean;
  changed: boolean;
  applied: boolean;
  reason: string;
  reasons: string[];
  baselineAction: HorseDecision['action'];
  baselineAmount: number | null;
  candidateAction: HorseDecision['action'];
  candidateAmount: number | null;
  objective: string | null;
  confidence: 'unavailable' | 'retained_uncertainty' | 'model_separated' | 'catastrophe_guard';
  futureGame: TournamentFutureGame | null;
  baselineFutureGame: TournamentFutureGame | null;
  boundaries: typeof PHASE8_POLICY;
  continuationPolicy: typeof CONTINUATION_POLICY;
  continuationRetained: boolean;
  baselineCriticalCommitment: boolean;
  candidateCriticalCommitment: boolean;
  before: HorseTournamentUtilityCandidateLedger[];
  after: HorseTournamentUtilityCandidateLedger[];
  latencyMs: number;
  simulationMs: number;
  policyMs: number;
  work: TournamentContinuationWork;
  executionStatus: 'pending' | 'intended' | 'coerced' | 'fallback' | 'not_executed';
  executedAction: HorseDecision['action'] | null;
  executedAmount: number | null;
}

const same = (a: HorseDecision, b: HorseDecision): boolean =>
  a.action === b.action && (!(a.action === 'bet' || a.action === 'raise') || a.amount === b.amount);
const matches = (c: HorseTournamentUtilityCandidateLedger, d: HorseDecision): boolean =>
  c.action === d.action && (!(c.action === 'bet' || c.action === 'raise') || c.amount === d.amount);

/** Public geometry bucket shared by policy, replays and tournament evidence. */
export function deepOnePairCommitment(
  hero: SeatPlayer,
  gs: HorseGameStateV2,
  investment: number
): boolean {
  if (!(gs.bigBlind > 0) || gs.communityCards.length < 3 || hero.cards.length !== 2) return false;
  const fullStack = hero.stack + hero.totalInvested;
  const made = Math.floor(
    scoreHoldem(
      [...hero.cards, ...gs.communityCards],
      hero.cards.length + gs.communityCards.length,
      false
    ) / 0x100000
  );
  const boardPair = gs.communityCards.some(
    (c, i, a) => a.findIndex((x) => x.rank === c.rank) !== i
  );
  const pocket = hero.cards[0].rank === hero.cards[1].rank;
  const set = pocket && gs.communityCards.some((c) => c.rank === hero.cards[0].rank);
  const weakMade = made <= 2 || (made === 3 && boardPair && !set);
  const opponents = gs.players.filter(
    (p) => p.user_id !== hero.user_id && !p.is_folded && (!p.is_sitting_out || p.is_all_in)
  );
  const opponentIds = new Set(opponents.map((p) => p.user_id));
  // Uncalled excess is returned. Only additional chips a live opponent can
  // match can make this a catastrophic commitment, including across side pots.
  const matchableTotal = opponents.reduce(
    (highest, p) => Math.max(highest, p.stack + p.totalInvested),
    0
  );
  const effectiveRisk = Math.min(
    investment,
    hero.stack,
    Math.max(0, matchableTotal - hero.totalInvested)
  );
  const pressure = (gs.actionHistory ?? []).some(
    (a) =>
      a.stage !== 'preflop' &&
      opponentIds.has(a.userId) &&
      // The controller leaves isFullRaise undefined for an all-in call.
      // Both full and short raises add pressure; a call-off does not.
      (a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise !== undefined))
  );
  return (
    fullStack / gs.bigBlind >= PHASE8_POLICY.deepStackBB &&
    weakMade &&
    pressure &&
    effectiveRisk >= fullStack * PHASE8_POLICY.deepCommitFraction
  );
}

/** A concrete nut-flush blocker; arbitrary high cards are not certified blockers. */
export function hasTournamentNutBlocker(hero: SeatPlayer, gs: HorseGameStateV2): boolean {
  return hero.cards.some(
    (h) => h.rank === 'A' && gs.communityCards.filter((c) => c.suit === h.suit).length >= 3
  );
}

/** No persistent state and no I/O. A clock is supplied by the worker boundary. */
export function evaluateTournamentPostflop(
  hero: SeatPlayer,
  gs: HorseGameStateV2,
  baseline: HorseDecision,
  utilityInput: TournamentUtilityInput | null,
  mode: Exclude<Phase8Mode, 'off'>,
  now: () => number,
  reuseUtility?: TournamentContinuationRunner
): { decision: HorseDecision; ledger: HorseTournamentPostflopLedger } {
  const start = now();
  const ledger: HorseTournamentPostflopLedger = {
    version: PHASE8_POLICY.version,
    mode,
    eligible: false,
    fired: false,
    completed: false,
    changed: false,
    applied: false,
    reason: 'unavailable',
    reasons: [],
    baselineAction: baseline.action,
    baselineAmount: baseline.amount ?? null,
    candidateAction: baseline.action,
    candidateAmount: baseline.amount ?? null,
    objective: baseline.tournamentUtility?.objective ?? null,
    confidence: 'unavailable',
    futureGame: null,
    baselineFutureGame: null,
    boundaries: PHASE8_POLICY,
    continuationPolicy: CONTINUATION_POLICY,
    continuationRetained: true,
    baselineCriticalCommitment: false,
    candidateCriticalCommitment: false,
    before: baseline.tournamentUtility?.candidates ?? [],
    after: [],
    latencyMs: 0,
    simulationMs: 0,
    policyMs: 0,
    work: {
      attempts: 0,
      candidateCount: 0,
      candidatesCompleted: 0,
      outcomeSamples: 0,
      samplesVisited: 0,
      rollouts: 0,
      rolloutCacheHits: 0,
      estimates: 0,
      estimateCacheHits: 0,
      icmMethod: 'unavailable',
      levelBounds: 0,
      budgetStop: 'none',
    },
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
  };
  const finish = (
    reason: string,
    decision = baseline,
    completed = false
  ): { decision: HorseDecision; ledger: HorseTournamentPostflopLedger } => {
    ledger.reason = reason;
    ledger.completed = completed && ledger.eligible && ledger.fired;
    ledger.latencyMs = Math.max(0, now() - start);
    ledger.policyMs = Math.max(0, ledger.latencyMs - ledger.simulationMs);
    if (
      !Number.isFinite(ledger.latencyMs) ||
      ledger.latencyMs > PHASE8_POLICY.budgetMs ||
      ledger.policyMs > PHASE8_POLICY.policyBudgetMs
    ) {
      ledger.reason = 'budget_exhausted';
      ledger.completed = false;
      ledger.applied = false;
      ledger.continuationRetained = true;
      return { decision: baseline, ledger };
    }
    return { decision, ledger };
  };
  if (!['flop', 'turn', 'river'].includes(gs.stage)) return finish('not_postflop');
  if (gs.gameMode !== 'tournament' || gs.gameVariant !== 'nlh')
    return finish('unsupported_variant');
  if (gs.stateSchemaVersion !== 1 || gs.tournament?.contextStatus !== 'complete')
    return finish('context_incomplete');
  if ((gs.boardCount ?? 1) > 1 || gs.communityCards2?.length || gs.communityCards3?.length)
    return finish('multiple_boards');
  if (!utilityInput || !baseline.tournamentUtility) return finish('utility_unavailable');
  const context = utilityInput.context;
  if (
    context.satellite &&
    (context.isPko || context.isBounty || context.isMysteryBounty || context.bountyPoolCents > 0)
  )
    return finish('objective_conflict');
  if (
    context.isMysteryBounty &&
    context.mysteryBountyStage === 'active' &&
    !(context.mysteryMeanCents > 0)
  )
    return finish('mystery_value_unavailable');
  if (gs.players.some((p) => p.cards.length > 0)) return finish('private_state_rejected');
  const previous = baseline.tournamentUtility;
  if (previous.candidates.length > PHASE8_POLICY.maxCandidates || !previous.candidates.length)
    return finish('candidate_budget');
  const base = previous.candidates.find((c) => matches(c, baseline));
  if (!base) return finish('baseline_not_modeled');
  ledger.baselineCriticalCommitment = deepOnePairCommitment(hero, gs, base.investment);
  ledger.candidateCriticalCommitment = ledger.baselineCriticalCommitment;
  ledger.futureGame = projectTournamentFutureGame(hero, gs, base.investment);
  ledger.baselineFutureGame = ledger.futureGame;
  if (!ledger.futureGame.available) return finish('future_context_unavailable');
  // Preserve a confident Phase 7 choice and its original receipt. Phase 8
  // never turns an already-certified terminal utility action into a heuristic.
  if (previous.overrodeBaseline) return finish('phase7_choice_retained');
  if (!Number.isInteger(gs.dealerSeat) || !(gs.bigBlind > 0)) return finish('position_unavailable');
  ledger.eligible = true;
  const simulationStart = now();
  let continuation: ReturnType<typeof evaluateTournamentUtilityDetailed>;
  try {
    const config = {
      dealerSeat: gs.dealerSeat!,
      bigBlind: gs.bigBlind,
      futureHands: {
        levels: [
          {
            smallBlind: gs.tournament!.currentSmallBlind!,
            bigBlind: gs.tournament!.currentBigBlind!,
            ante: gs.tournament!.currentAnte!,
            anteType: gs.tournament!.anteType!,
          },
          ...(ledger.futureGame.levelTiming === 'current_and_next_level_envelope'
            ? [
                {
                  smallBlind: gs.tournament!.nextSmallBlind!,
                  bigBlind: gs.tournament!.nextBigBlind!,
                  ante: gs.tournament!.nextAnte!,
                  anteType: gs.tournament!.anteType!,
                },
              ]
            : []),
        ],
        nextLevelDue: gs.tournament!.nextBlindInMin === 0,
      },
      shortStackThresholdChips:
        ledger.futureGame.nextOrbitCost ?? ledger.futureGame.currentOrbitCost ?? 0,
      withinBudget: () => now() - start <= PHASE8_POLICY.workBudgetMs,
      work: ledger.work,
    };
    const run = (maxSamples: number) =>
      reuseUtility
        ? reuseUtility(baseline, config, maxSamples)
        : evaluateTournamentUtilityDetailed({
            ...utilityInput,
            baseline,
            showdownSamples: selectContinuationSamples(utilityInput.showdownSamples, maxSamples),
            continuation: config,
          });
    continuation = run(PHASE8_POLICY.maxFutureOutcomeSamples);
    // A smaller stratified pool must not erase a rare outcome. Retry the full
    // captured pool only for calibration failure and within the same deadline.
    if (continuation.unavailableReason === 'sample_calibration' && config.withinBudget()) {
      continuation = run(CONTINUATION_POLICY.maxOutcomeSamples);
    }
  } catch {
    ledger.simulationMs = Math.max(0, now() - simulationStart);
    return finish('continuation_numerical_error');
  }
  ledger.simulationMs = Math.max(0, now() - simulationStart);
  if (!continuation.result) return finish(`continuation_${continuation.unavailableReason}`);
  ledger.fired = true;
  ledger.continuationRetained = false;
  ledger.after = continuation.result.ledger.candidates;
  let candidate = continuation.result.decision;
  ledger.confidence = continuation.result.ledger.baselineRetainedForUncertainty
    ? 'retained_uncertainty'
    : 'model_separated';
  const selected = ledger.after.find((c) => matches(c, candidate));
  const exposed = selected?.investment ?? base.investment;
  if (deepOnePairCommitment(hero, gs, exposed)) {
    const safe =
      ledger.after.find((c) => c.action === 'check') ??
      ledger.after.find((c) => c.action === 'fold');
    if (safe) {
      candidate = { action: safe.action, thinkTime: baseline.thinkTime };
      ledger.confidence = 'catastrophe_guard';
      ledger.reasons.push('deep_one_pair_commitment');
    }
  }
  const picked = ledger.after.find((c) => matches(c, candidate));
  if (!picked || !(gs.legalActions ?? []).includes(candidate.action))
    return finish('illegal_candidate');
  if (picked.stackConservationError > 0.005) return finish('conservation_error');
  if (picked.investment > hero.stack) return finish('illegal_candidate');
  ledger.futureGame = projectTournamentFutureGame(hero, gs, picked.investment);
  const pot = Math.max(1, gs.contestablePot ?? gs.pot);
  if (
    candidate.action === 'all_in' &&
    utilityInput.heroEquity < PHASE8_POLICY.bluffEquityCeiling &&
    !same(candidate, baseline)
  ) {
    // Bluff risk must be covered by modeled folds even before crediting wins.
    const breakEvenFold = picked.investment / (pot + picked.investment);
    if (
      !hasTournamentNutBlocker(hero, gs) ||
      picked.allFoldProbability <= breakEvenFold ||
      ledger.confidence !== 'model_separated'
    )
      return finish('blocker_jam_unproven');
    ledger.reasons.push('blocker_jam');
  }
  if (hero.stack / pot <= PHASE8_POLICY.lowSpr) ledger.reasons.push('low_spr');
  if (previous.coveringPlayers.length > 0) ledger.reasons.push('covered_stack');
  if (ledger.futureGame.coveredStacks > 0) ledger.reasons.push('covering_pressure');
  if (utilityInput.opponents.length > 1) ledger.reasons.push('multiway');
  if (previous.playersBehind.length > 0) ledger.reasons.push('players_behind');
  if (candidate.action === 'check') ledger.reasons.push('protected_check');
  if (candidate.action === 'bet' || candidate.action === 'raise')
    ledger.reasons.push('legal_pressure_size');
  if (previous.objective === 'pko' || previous.objective === 'mystery_bounty')
    ledger.reasons.push('bounty_counted_once');
  if (previous.objective === 'satellite_seat_equity') ledger.reasons.push('seat_equity');
  if (gs.stage === 'river') {
    const chipBest = ledger.after.slice().sort((a, b) => b.chipEv - a.chipEv)[0];
    if (chipBest.id !== picked.id) ledger.reasons.push('river_prize_over_chips');
  }
  ledger.changed = !same(candidate, baseline);
  ledger.candidateCriticalCommitment = deepOnePairCommitment(hero, gs, picked.investment);
  ledger.candidateAction = candidate.action;
  ledger.candidateAmount = candidate.amount ?? null;
  ledger.applied = mode === 'candidate' && ledger.changed;
  const final = ledger.applied
    ? { ...candidate, tournamentUtility: baseline.tournamentUtility }
    : baseline;
  return finish(ledger.changed ? 'candidate_changed' : 'baseline_retained', final, true);
}
