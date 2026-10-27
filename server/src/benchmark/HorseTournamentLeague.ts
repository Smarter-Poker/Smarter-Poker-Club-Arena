/** Paired whole tournaments through the real controller, inside the league process. */
import {
  CATASTROPHE_GUARD_VERSION,
  type HorseTournamentCatastropheGuardLedger,
} from '../engine/HorseTournamentCatastropheGuard.js';
import { HandController } from '../engine/HandController.js';
import { HorseLogic, type HorseGameStateV2, type HorseDecideOpts } from '../engine/HorseLogic.js';
import { HorseMind } from '../engine/HorseMind.js';
import { saveFastRandom, restoreFastRandom, seedFastRandom } from '../engine/HorseEval.js';
import { calculateContestablePot, RANKS, SUITS } from '../engine/PokerEngine.js';
import { holeCardCount, horseVariantRulesFor } from '../engine/VariantRules.js';
import { buildTournamentMState } from '../engine/HorseTournamentPreflop.js';
import { attributeKnockout, type KnockoutClaimant } from '../tournament/knockoutAttribution.js';
import {
  deepOnePairCommitment,
  futureHandSeats,
  PHASE8_POLICY,
  type Phase8Mode,
  type HorseTournamentPostflopLedger,
} from '../engine/HorseTournamentPostflop.js';
import type { Card, HandEvent, HorseDecision, SeatPlayer, Winner, PerPotAward } from '../types.js';
import {
  HUMAN_CALIBRATED_POPULATION_ID,
  humanCalibratedDecide,
  type HumanCalibratedSpot,
} from './HumanCalibratedPopulation.js';

import {
  tournamentFlagCard,
  validateTournamentFlagRequest,
  type TournamentFlagVariant,
  type TournamentFlagAdmission,
} from './HorseTournamentFlagContract.js';

export const TOURNAMENT_LEAGUE_OBJECTIVES = [
  'mtt',
  'sng',
  'spin',
  'satellite',
  'pko',
  'mystery',
] as const;
export type TournamentLeagueObjective = (typeof TOURNAMENT_LEAGUE_OBJECTIVES)[number];
export const TOURNAMENT_PROMOTION_SEEDS = [8101101, 8102203, 8103307] as const;
export const TOURNAMENT_PROMOTION_PAIRS = 1024;
const MAX_HANDS = 96;
const MAX_ACTIONS = 256;
export function tournamentLeagueEntrants(objective: TournamentLeagueObjective): number {
  return objective === 'spin' ? 3 : objective === 'sng' ? 6 : 18;
}

/** The league forecast must describe the same schedule that deals its next level. */
export function tournamentLeagueBlindLevels(level: number) {
  const at = (index: number) => {
    const bigBlind = 10 * 2 ** index;
    return { smallBlind: bigBlind / 2, bigBlind, ante: index >= 2 ? Math.round(bigBlind / 10) : 0 };
  };
  const current = at(level);
  const next = at(level + 1);
  const anteType = current.ante > 0 || next.ante > 0 ? ('per_player' as const) : ('none' as const);
  return { current, next, anteType };
}

/** A dead heat can split the last satellite award. Counting every nonzero
 * fraction as a whole seat would create more seat equity than was funded. */
export function realizedTournamentReturn(
  objective: TournamentLeagueObjective,
  prizePct: number,
  paidBounty: number,
  prizePool: number,
  bountyPool: number
): number {
  return objective === 'satellite'
    ? prizePct / 50 // The declared league satellite funds two equal seats.
    : ((prizePct / 100) * prizePool + paidBounty) / (prizePool + bountyPool);
}

export interface KnockoutBountyShare {
  userId: string;
  amount: number;
}

/**
 * One knockout pays ONE bounty. A tied pot shares it between the claimants by
 * claim weight, and the shares sum to the bounty exactly. This is the engine's
 * own rule: `fn_mystery_bounty_reserve` splits the chest as
 * `amount * weight / total_weight` and `fn_collect_bounty` splits a PKO head
 * the same way before halving each share onto its winner's head. Paying the
 * full bounty to every tied winner paid a chopped knockout twice and drained
 * the funded pool below zero before the champion was reached.
 *
 * An empty result means no claimant can be paid and is a conservation error.
 */
export function knockoutBountyShares(
  bounty: number,
  claimants: readonly KnockoutClaimant[]
): KnockoutBountyShare[] {
  const weights = new Map<string, number>();
  for (const claimant of claimants) {
    const weight = Number(claimant.weight);
    if (!claimant.userId || !Number.isFinite(weight) || weight <= 0) continue;
    weights.set(claimant.userId, (weights.get(claimant.userId) ?? 0) + weight);
  }
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0) || !Number.isFinite(bounty) || bounty < 0) return [];
  const entries = [...weights.entries()];
  let allocated = 0;
  return entries.map(([userId, weight], index) => {
    const amount = index === entries.length - 1 ? bounty - allocated : (bounty * weight) / total;
    allocated += amount;
    return { userId, amount };
  });
}

export const TOURNAMENT_POLICY_FAMILIES = ['continuation_v2', 'catastrophe_guard_v1'] as const;
export type TournamentPolicyFamily = (typeof TOURNAMENT_POLICY_FAMILIES)[number];
export function tournamentPolicyFamily(value?: unknown): TournamentPolicyFamily {
  if (value === undefined) return 'continuation_v2';
  if (value === 'continuation_v2' || value === 'catastrophe_guard_v1') return value;
  throw new Error('Unknown tournament policy family');
}
export function tournamentPolicyVersion(family: TournamentPolicyFamily) {
  return family === 'catastrophe_guard_v1' ? CATASTROPHE_GUARD_VERSION : PHASE8_POLICY.version;
}
export function tournamentPolicyWorkKind(family: TournamentPolicyFamily) {
  return family === 'catastrophe_guard_v1'
    ? ('phase7_candidate_guard' as const)
    : ('future_hand_continuation' as const);
}

export interface TournamentLeagueRequest {
  flagCard?: string;
  firstPair?: number;
  flagQualification?: TournamentFlagAdmission;
  objective: TournamentLeagueObjective;
  phase8PolicyFamily?: TournamentPolicyFamily;
  pairs: number;
  seed: number;
  /** Test mirror; production promotion always compares candidate with off. */
  candidateMode?: Phase8Mode;
  evidenceMode?: 'fixture' | 'promotion';
  /**
   * Post-launch condition (b) monitoring (winning contract, Amendment Of
   * October 9, 2026): every non-hero entrant plays the human-calibrated NLH
   * profile instead of a `balanced` horse and is seated as a human
   * (`is_horse: false`). Absent: the Phase 8 field, unchanged.
   */
  opponentPopulation?: typeof HUMAN_CALIBRATED_POPULATION_ID;
}
export const MAX_TOURNAMENT_COMPLETION_DIAGNOSTICS = 256;
export interface TournamentCompletionDiagnostic {
  workKind?: ReturnType<typeof tournamentPolicyWorkKind>;
  guardWork?: HorseTournamentCatastropheGuardLedger['guardWork'];
  street: string;
  localPlayers: number;
  fieldPlayers: number;
  completed: boolean;
  reason: string;
  latencyMs: number;
  work: HorseTournamentPostflopLedger['work'];
}
export interface TournamentCompletionCounts {
  /** Optional observational counters for the evaluated arm only; absent in older receipts. */
  opportunityDiagnostics?: TournamentOpportunityDiagnostics;
  completionSchemaVersion: 1;
  completed: number;
  completionRefusals: Record<string, number>;
  completionDiagnostics: TournamentCompletionDiagnostic[];
  completionDiagnosticsDropped: number;
}
export const TOURNAMENT_PRE_ELIGIBILITY_REASONS = [
  'not_postflop',
  'unsupported_variant',
  'context_incomplete',
  'multiple_boards',
  'utility_unavailable',
  'objective_conflict',
  'mystery_value_unavailable',
  'private_state_rejected',
  'candidate_budget',
  'baseline_not_modeled',
  'future_context_unavailable',
  'phase7_choice_retained',
  'position_unavailable',
  'future_hand_seats_outside_work_budget',
  'unknown_preeligibility_refusal',
] as const;
type TournamentPreEligibilityReason = (typeof TOURNAMENT_PRE_ELIGIBILITY_REASONS)[number];
export interface TournamentOpportunityDiagnostics {
  version: 1;
  arm: 'evaluated';
  decisions: number;
  designatedHeroDecisions: number;
  otherActorDecisions: number;
  heroPreflopDecisions: number;
  heroPostflopDecisions: number;
  heroOtherStreetDecisions: number;
  /** Geometry only: this does not assert that earlier context/utility gates passed. */
  heroPostflopWithinSeatBudget: number;
  heroPostflopLedgerMissing: number;
  heroPostflopEligible: number;
  preEligibleRefusals: Partial<Record<TournamentPreEligibilityReason, number>>;
}
function emptyTournamentOpportunities(): TournamentOpportunityDiagnostics {
  return {
    version: 1,
    arm: 'evaluated',
    decisions: 0,
    designatedHeroDecisions: 0,
    otherActorDecisions: 0,
    heroPreflopDecisions: 0,
    heroPostflopDecisions: 0,
    heroOtherStreetDecisions: 0,
    heroPostflopWithinSeatBudget: 0,
    heroPostflopLedgerMissing: 0,
    heroPostflopEligible: 0,
    preEligibleRefusals: {},
  };
}
/** Observe only AFTER the chooser has returned its finalized measured ledger.
 * This public aggregate never changes a ledger, sampling, clock or promotion gate. */
export function recordTournamentOpportunity(
  target: TournamentCompletionCounts,
  designatedHero: boolean,
  state: Pick<HorseGameStateV2, 'stage' | 'players'>,
  layer: HorseTournamentPostflopLedger | HorseTournamentCatastropheGuardLedger | undefined
): void {
  const d = (target.opportunityDiagnostics ??= emptyTournamentOpportunities());
  d.decisions++;
  if (!designatedHero) {
    d.otherActorDecisions++;
    return;
  }
  d.designatedHeroDecisions++;
  if (state.stage === 'preflop') {
    d.heroPreflopDecisions++;
    return;
  }
  if (!['flop', 'turn', 'river'].includes(state.stage)) {
    d.heroOtherStreetDecisions++;
    return;
  }
  d.heroPostflopDecisions++;
  if (futureHandSeats(state as HorseGameStateV2) <= PHASE8_POLICY.maxFutureHandSeats)
    d.heroPostflopWithinSeatBudget++;
  if (!layer) {
    d.heroPostflopLedgerMissing++;
    return;
  }
  if (layer.eligible) {
    d.heroPostflopEligible++;
    return;
  }
  const reason =
    TOURNAMENT_PRE_ELIGIBILITY_REASONS.find((r) => r === layer.reason) ??
    'unknown_preeligibility_refusal';
  d.preEligibleRefusals[reason] = (d.preEligibleRefusals[reason] ?? 0) + 1;
}
function mergeTournamentOpportunities(
  target: TournamentCompletionCounts,
  source: TournamentCompletionCounts
): void {
  const from = source.opportunityDiagnostics;
  if (!from) return;
  const into = (target.opportunityDiagnostics ??= emptyTournamentOpportunities());
  for (const key of [
    'decisions',
    'designatedHeroDecisions',
    'otherActorDecisions',
    'heroPreflopDecisions',
    'heroPostflopDecisions',
    'heroOtherStreetDecisions',
    'heroPostflopWithinSeatBudget',
    'heroPostflopLedgerMissing',
    'heroPostflopEligible',
  ] as const)
    into[key] += from[key];
  for (const reason of TOURNAMENT_PRE_ELIGIBILITY_REASONS)
    if (from.preEligibleRefusals[reason] !== undefined)
      into.preEligibleRefusals[reason] =
        (into.preEligibleRefusals[reason] ?? 0) + from.preEligibleRefusals[reason]!;
}
export function emptyTournamentCompletionCounts(): TournamentCompletionCounts {
  return {
    completionSchemaVersion: 1,
    completed: 0,
    completionRefusals: {},
    completionDiagnostics: [],
    completionDiagnosticsDropped: 0,
  };
}
/** Called only after HorseLogic has returned its final, legalized ledger. */
export function recordTournamentCompletion(
  target: TournamentCompletionCounts,
  layer: HorseTournamentPostflopLedger | HorseTournamentCatastropheGuardLedger,
  state: Pick<HorseGameStateV2, 'stage' | 'players' | 'tournament'>
): void {
  if (!layer.eligible) return;
  if (layer.completed) target.completed++;
  else target.completionRefusals[layer.reason] = (target.completionRefusals[layer.reason] ?? 0) + 1;
  if (target.completionDiagnostics.length >= MAX_TOURNAMENT_COMPLETION_DIAGNOSTICS) {
    target.completionDiagnosticsDropped++;
    return;
  }
  target.completionDiagnostics.push({
    ...('policyFamily' in layer && layer.policyFamily === 'catastrophe_guard_v1'
      ? { workKind: 'phase7_candidate_guard' as const, guardWork: { ...layer.guardWork } }
      : {}),
    street: state.stage,
    localPlayers: state.players.length,
    fieldPlayers: state.tournament?.playersLeft ?? 0,
    completed: layer.completed,
    reason: layer.reason,
    latencyMs: layer.latencyMs,
    work: { ...layer.work },
  });
}

export interface TournamentLeagueResult extends TournamentCompletionCounts {
  flagCard?: string;
  gameVariant?: TournamentFlagVariant;
  firstPair?: number;
  cardDecisions?: number;
  cardChanged?: number;
  cardPairs?: Array<{ index: number; candidate: number; reference: number }>;

  version: ReturnType<typeof tournamentPolicyVersion>;
  phase8PolicyFamily?: TournamentPolicyFamily;
  workKind?: ReturnType<typeof tournamentPolicyWorkKind>;
  /** Present only for a human-calibrated field (absent: the Phase 8 horse field). */
  opponentPopulation?: typeof HUMAN_CALIBRATED_POPULATION_ID;
  /** Human-calibrated entrants only: response counts per decision node, both arms. */
  humanResponses?: Record<string, Record<string, number>>;
  candidateMode: Phase8Mode;
  evidenceMode: 'fixture' | 'promotion';
  objective: TournamentLeagueObjective;
  entrants: number;
  seed: number;
  requestedPairs: number;
  pairs: number;
  complete: boolean;
  primaryMetric: 'funded_pool_return' | 'seat_attainment';
  meanDifference: number;
  standardError: number;
  confidence99: [number, number];
  candidateReturn: number;
  baselineReturn: number;
  chipDifference: number;
  bountyDifference: number;
  candidateBustRate: number;
  baselineBustRate: number;
  candidateFinish: number[];
  baselineFinish: number[];
  decisions: number;
  eligible: number;
  fired: number;
  changed: number;
  illegalActions: number;
  conservationErrors: number;
  truncatedHands: number;
  candidateDeepOnePairCommitments: number;
  baselineDeepOnePairCommitments: number;
  preventedCommitments: number;
  budgetExhaustions: number;
  referenceRegret: number;
  reference: 'phase7_action_utility_not_external_solver';
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  durationMs: number;
  promotionEligible: boolean;
}

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
function cardsFor(seed: number): Card[] {
  const cards = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
  const next = random(seed);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
function seat(index: number, stack: number): SeatPlayer {
  return {
    seat: index + 1,
    user_id: `phase8-league-${index + 1}`,
    username: `Horse ${index + 1}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
}
interface Receipt extends TournamentCompletionCounts {
  returned: number;
  chips: number;
  bounty: number;
  finish: number;
  complete: boolean;
  decisions: number;
  eligible: number;
  fired: number;
  changed: number;
  illegal: number;
  conservation: number;
  truncated: number;
  deep: number;
  prevented: number;
  budget: number;
  regret: number;
  latency: number[];
  humanResponses: Record<string, Record<string, number>>;
  cardDecisions?: number;
  cardChanged?: number;
}

/** A human-calibrated entrant's decision from the authoritative menu and public state. */
function humanCalibratedEntrantDecision(
  seatPlayer: SeatPlayer,
  state: ReturnType<HandController['getState']>,
  menu: NonNullable<ReturnType<HandController['getAuthoritativeActionState']>>,
  receipt: Receipt,
  variant: string = 'nlh'
): HorseDecision {
  const spot: HumanCalibratedSpot = {
    variant,
    stage: state.stage,
    cards: seatPlayer.cards,
    board: state.communityCards,
    pot: state.pot,
    toCall: menu.toCall,
    currentBet: state.currentBet,
    aggressionThisStreet: state.actionHistory.some(
      (a) =>
        a.stage === state.stage &&
        (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in')
    ),
    legalActions: menu.legalActions,
    minRaiseTo: menu.minRaiseTo,
    maxRaiseTo: menu.maxRaiseTo,
    wholeChips: true,
  };
  const d = humanCalibratedDecide(spot);
  const tally = (receipt.humanResponses[d.node] ??= {});
  tally[d.action] = (tally[d.action] ?? 0) + 1;
  return {
    action: d.action,
    ...(d.amount !== undefined ? { amount: d.amount } : {}),
    thinkTime: 0,
  };
}

async function playTournament(
  seed: number,
  objective: TournamentLeagueObjective,
  heroSeat: number,
  mode: Phase8Mode,
  shouldContinue: () => boolean,
  opponentPopulation: typeof HUMAN_CALIBRATED_POPULATION_ID | null = null,
  family: TournamentPolicyFamily = 'continuation_v2',
  flag: {
    variant: TournamentFlagVariant;
    hero: HorseDecideOpts;
    counterfactual: HorseDecideOpts | null;
  } | null = null
): Promise<Receipt> {
  const variant: TournamentFlagVariant | 'nlh' = flag?.variant ?? 'nlh';
  const holeCount = holeCardCount(variant);
  const count = tournamentLeagueEntrants(objective);
  const startStack = 2000;
  const players = Array.from({ length: count }, (_, i) =>
    opponentPopulation && i !== heroSeat
      ? { ...seat(i, startStack), username: `Human ${i + 1}`, is_horse: false }
      : seat(i, startStack)
  );
  const heroId = players[heroSeat].user_id;
  const originalIds = players.map((p) => p.user_id);
  const heads = new Map(players.map((p) => [p.user_id, 1000]));
  const prizes =
    objective === 'spin'
      ? [100]
      : objective === 'satellite'
        ? [50, 50]
        : objective === 'sng'
          ? [65, 35]
          : [50, 30, 20];
  const prizePool = (objective === 'pko' || objective === 'mystery' ? 1000 : 2000) * count;
  const bountyPool = objective === 'pko' || objective === 'mystery' ? count * 1000 : 0;
  const receipt: Receipt = {
    ...emptyTournamentCompletionCounts(),
    returned: 0,
    chips: 0,
    bounty: 0,
    finish: count,
    complete: false,
    decisions: 0,
    eligible: 0,
    fired: 0,
    changed: 0,
    illegal: 0,
    conservation: 0,
    truncated: 0,
    deep: 0,
    prevented: 0,
    budget: 0,
    regret: 0,
    latency: [],
    humanResponses: {},
    ...(flag ? { cardDecisions: 0, cardChanged: 0 } : {}),
  };
  let alive = players;
  const buttons = new Map<number, number>();
  let heroPrize = 0;
  let paidBounties = 0;
  const sandbox = HorseMind.createSandbox();
  for (let hand = 0; hand < MAX_HANDS && alive.length > 1; hand++) {
    if (!shouldContinue()) return receipt;
    // Declared league schedule: six-seat tables, balanced after each completed
    // hand in stable entrant order. Only this table plays; remote stacks remain
    // in the actual tournament field supplied to Phase 7's ICM workspace.
    const tableCount = Math.ceil(alive.length / 6);
    const tableIndex = hand % tableCount;
    const tablePlayers = alive
      .filter((_, index) => index % tableCount === tableIndex)
      .map((p, index) => ({ ...p, seat: index + 1 }));
    const dealerSeat = Math.min(buttons.get(tableIndex) ?? 1, tablePlayers.length);
    const level = Math.floor(hand / 6);
    const { current, next, anteType } = tournamentLeagueBlindLevels(level);
    const { bigBlind, ante } = current;
    const starts = new Map(alive.map((p) => [p.user_id, p.stack]));
    const totalBefore = alive.reduce((sum, p) => sum + p.stack, 0);
    const config = {
      tableId: 'phase8-tournament-league',
      handNumber: hand + 1,
      gameVariant: variant,
      isTournament: true,
      smallBlind: current.smallBlind,
      bigBlind,
      ante,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    };
    const controller = new HandController(config, tablePlayers, dealerSeat);
    // Replace methods only on this isolated controller's deck instance. No
    // production shuffle, prototype, flag or live object is changed. Every
    // original seat retains identical holes and board even after paths diverge.
    const full = cardsFor((seed ^ Math.imul(hand + 1, 2654435761)) >>> 0);
    // Preserve the NLH entrant assignment exactly. Omaha uses six table slots:
    // eighteen PLO6 entrants cannot each reserve six cards from one deck.
    const boardStart = flag ? 6 * holeCount : count * 2;
    const fixedBoard = full.slice(boardStart, boardStart + 5);
    const deck = tablePlayers
      .flatMap((p, slot) => {
        const i = flag ? slot : originalIds.indexOf(p.user_id);
        return full.slice(i * holeCount, i * holeCount + holeCount);
      })
      .concat(fixedBoard, full.slice(boardStart + 5));
    const instance = controller.getState().deck as unknown as {
      deal: (n?: number) => Card[];
      dealOne: () => Card;
      remaining: () => number;
      getRemainingCards: () => Card[];
    };
    instance.deal = (n = 1) => {
      if (deck.length < n) throw new Error('Tournament league exhausted its deck');
      return deck.splice(0, n);
    };
    instance.dealOne = () => instance.deal(1)[0];
    instance.remaining = () => deck.length;
    instance.getRemainingCards = () => deck.slice();
    let complete = false;
    let runout = false;
    let winners: Winner[] = [];
    let awards: PerPotAward[] = [];
    controller.onEvent((event: HandEvent) => {
      if (event.type === 'HAND_COMPLETE') complete = true;
      if (event.type === 'ALL_IN_RUNOUT') runout = true;
      if (event.type === 'WINNERS') {
        winners = event.winners;
        awards = event.perPotAwards ?? [];
      }
    });
    controller.start();
    for (let action = 0; action < MAX_ACTIONS && !complete; action++) {
      if (runout) {
        runout = false;
        controller.continueRunout();
        continue;
      }
      const state = controller.getState();
      const hero = state.players.find((p) => p.seat === state.currentPlayerSeat);
      if (!hero) {
        receipt.truncated++;
        break;
      }
      const menu = controller.getAuthoritativeActionState(hero.user_id);
      if (!menu?.canAct) {
        receipt.truncated++;
        break;
      }
      const field = alive.map((p) => {
        const local = state.players.find((q) => q.user_id === p.user_id);
        return local ? local.stack + local.totalInvested : p.stack;
      });
      const tournament: NonNullable<HorseGameStateV2['tournament']> = {
        schemaVersion: 1,
        contextStatus: 'complete',
        contextIssues: [],
        sourceAgeMs: 0,
        tournamentId: 'phase8-league',
        playersLeft: alive.length,
        entrants: count,
        spotsPaid: prizes.length,
        payoutPct: prizes.slice(0, alive.length),
        stacks: field,
        stackByUser: Object.fromEntries(
          state.players.map((p) => [p.user_id, p.stack + p.totalInvested])
        ),
        currentSmallBlind: current.smallBlind,
        currentBigBlind: bigBlind,
        currentAnte: ante,
        anteType,
        playersAtTable: state.players.length,
        seatsPerTable: 6,
        nextSmallBlind: next.smallBlind,
        nextBigBlind: next.bigBlind,
        nextAnte: next.ante,
        nextBlindInMin: (6 - (hand % 6)) / 2,
        currentLevel: level,
        levelDurationMin: 3,
        levelElapsedMin: (hand % 6) / 2,
        prizePoolCents: prizePool,
        bountyPoolCents: bountyPool,
        satellite: objective === 'satellite',
        satelliteSeats: objective === 'satellite' ? 2 : 0,
        isPko: objective === 'pko',
        isBounty: objective === 'pko',
        isMysteryBounty: objective === 'mystery',
        mysteryBountyStage: objective === 'mystery' ? 'active' : 'none',
        mysteryMeanCents: objective === 'mystery' ? 1000 : 0,
        meanBountyCents: bountyPool ? 1000 : 0,
        bountyByUser: Object.fromEntries(heads),
        bountyFactor: bountyPool ? 1 : 0,
        reentryOpen: false,
        rebuyOpen: false,
        addOnPeriodOpen: false,
        reloadsUsed: 0,
        addOnTaken: false,
        rebuyAffordable: false,
        addOnAffordable: false,
        maxReentries: 0,
        maxRebuys: 0,
      };
      tournament.m = buildTournamentMState({
        stackChips: hero.stack,
        smallBlind: current.smallBlind,
        bigBlind,
        ante,
        anteType: tournament.anteType!,
        playersAtTable: state.players.length,
        nextSmallBlind: next.smallBlind,
        nextBigBlind: next.bigBlind,
        nextAnte: next.ante,
        minutesToNextLevel: tournament.nextBlindInMin,
      });
      const gs: HorseGameStateV2 = {
        players: state.players.map((p) => ({ ...p, cards: [] })),
        communityCards: state.communityCards,
        pot: state.pot,
        currentBet: state.currentBet,
        stage: state.stage,
        minRaise: state.minRaise,
        lastRaise: state.lastRaise,
        dealerSeat: state.dealerSeat,
        stateSchemaVersion: 1,
        heroSeat: hero.seat,
        currentPlayerSeat: hero.seat,
        gameMode: 'tournament',
        format: objective === 'spin' ? 'spin' : objective === 'sng' ? 'sng' : 'mtt',
        gameVariant: variant,
        bigBlind,
        ante,
        boardCount: 1,
        legalActions: menu.legalActions,
        toCall: menu.toCall,
        minRaiseTo: menu.minRaiseTo,
        maxRaiseTo: menu.maxRaiseTo,
        bettingStructure: menu.structure,
        pots: controller.computeLivePots(),
        contestablePot: calculateContestablePot(state.players, hero.user_id, menu.toCall),
        variantRules: horseVariantRulesFor(variant),
        rakeConfig: config.rakeConfig,
        tournament,
        actionHistory: state.actionHistory.map((a, i) => ({
          ...a,
          timestamp: hand * 1000 + i + 1,
        })),
      };
      seedFastRandom(
        (seed ^ Math.imul(hand + 1, 104729) ^ Math.imul(action + 1, 1009) ^ hero.seat) >>> 0
      );
      const decideWith = (extra: HorseDecideOpts): HorseDecision =>
        HorseMind.runInSandbox(sandbox, () =>
          HorseLogic.decide(
            hero,
            gs,
            'balanced',
            {},
            {
              ...extra,
              phase8Postflop: flag ? 'off' : hero.user_id === heroId ? mode : 'off',
              phase8PolicyFamily: family,
              mind: false,
              telemetry: false,
              decisionTimeMs: 0,
            }
          )
        );
      let decision: HorseDecision =
        opponentPopulation !== null && hero.user_id !== heroId
          ? humanCalibratedEntrantDecision(hero, state, menu, receipt, variant)
          : decideWith(hero.user_id === heroId && flag ? flag.hero : {});
      if (flag?.counterfactual && hero.user_id === heroId) {
        const live = saveFastRandom();
        seedFastRandom(
          (seed ^ Math.imul(hand + 1, 104729) ^ Math.imul(action + 1, 1009) ^ hero.seat) >>> 0
        );
        const other = decideWith(flag.counterfactual);
        restoreFastRandom(live);
        receipt.cardDecisions!++;
        if (
          other.action !== decision.action ||
          (other.amount ?? null) !== (decision.amount ?? null)
        )
          receipt.cardChanged!++;
      }
      receipt.decisions++;
      const layer = decision.tournamentCatastropheGuard ?? decision.tournamentPostflop;
      recordTournamentOpportunity(receipt, hero.user_id === heroId, gs, layer);
      if (layer) {
        recordTournamentCompletion(receipt, layer, gs);
        receipt.eligible += Number(layer.eligible);
        receipt.fired += Number(layer.fired);
        receipt.changed += Number(layer.applied);
        receipt.latency.push(layer.latencyMs);
        if (layer.applied && layer.reasons.includes('deep_one_pair_commitment'))
          receipt.prevented++;
        if (layer.reason === 'budget_exhausted' || layer.reason === 'continuation_operation_budget')
          receipt.budget++;
        const picked = layer.before.find(
          (c) =>
            c.action === decision.action &&
            (!(c.action === 'raise' || c.action === 'bet') || c.amount === decision.amount)
        );
        if (picked)
          receipt.regret += Math.max(
            0,
            ...layer.before.map((c) => c.combinedUtility - picked.combinedUtility)
          );
      }
      const investment =
        decision.action === 'all_in'
          ? hero.stack
          : decision.action === 'call'
            ? Math.min(hero.stack, menu.toCall)
            : decision.action === 'bet' || decision.action === 'raise'
              ? Math.max(0, (decision.amount ?? 0) - hero.bet)
              : 0;
      if (hero.user_id === heroId && deepOnePairCommitment(hero, gs, investment)) receipt.deep++;
      if (
        !menu.legalActions.includes(decision.action) ||
        !controller.performAction(hero.seat, decision.action, decision.amount)
      ) {
        receipt.illegal++;
        break;
      }
    }
    if (!complete) {
      receipt.truncated++;
      return receipt;
    }
    const end = controller.getState();
    const updated = alive.map((p) => {
      const local = end.players.find((q) => q.user_id === p.user_id);
      return local ? { ...p, stack: local.stack } : p;
    });
    const sum = updated.reduce((s, p) => s + p.stack, 0);
    if (Math.abs(sum - totalBefore) > 0.01) {
      receipt.conservation++;
      return receipt;
    }
    const busted = end.players.filter((p) => p.stack <= 0);
    for (const p of busted) {
      const smaller = busted.filter((q) => starts.get(q.user_id)! < starts.get(p.user_id)!).length;
      const tied = busted.filter((q) => starts.get(q.user_id) === starts.get(p.user_id)).length;
      if (p.user_id === heroId) {
        receipt.finish = alive.length - smaller;
        for (let offset = 0; offset < tied; offset++)
          heroPrize += (prizes[alive.length - smaller - offset - 1] ?? 0) / tied;
      }
      if (bountyPool) {
        const attribution = attributeKnockout(
          { pots: end.pots, winners: awards.length ? awards : winners },
          p.user_id
        );
        const bounty = objective === 'pko' ? (heads.get(p.user_id) ?? 0) : 1000;
        const shares = knockoutBountyShares(bounty, attribution.claimants);
        if (!shares.length) {
          receipt.conservation++;
          return receipt;
        }
        for (const share of shares) {
          const paid = share.amount * (objective === 'pko' ? 0.5 : 1);
          paidBounties += paid;
          if (share.userId === heroId) receipt.bounty += paid;
          if (objective === 'pko') heads.set(share.userId, (heads.get(share.userId) ?? 0) + paid);
        }
        heads.delete(p.user_id);
      }
    }
    alive = updated.filter((p) => p.stack > 0);
    buttons.set(tableIndex, (dealerSeat % tablePlayers.length) + 1);
    if (objective === 'satellite' && alive.length <= 2) {
      if (alive.some((p) => p.user_id === heroId)) {
        heroPrize = 50;
        receipt.finish = 1;
      }
      receipt.complete = true;
      break;
    }
    if (alive.length === 1) {
      // Match completionSettlementReceipt: the remaining funded bounty pool
      // is paid to the champion. A rolled PKO head is counted only now, when
      // it becomes a realized payment, never at both collection and rollover.
      const residual = bountyPool - paidBounties;
      if (residual < -0.01) {
        receipt.conservation++;
        return receipt;
      }
      if (alive[0].user_id === heroId) {
        heroPrize = prizes[0];
        receipt.finish = 1;
        receipt.bounty += Math.max(0, residual);
      }
      receipt.complete = true;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  receipt.chips = (alive.find((p) => p.user_id === heroId)?.stack ?? 0) - startStack;
  receipt.returned = realizedTournamentReturn(
    objective,
    heroPrize,
    receipt.bounty,
    prizePool,
    bountyPool
  );
  return receipt;
}

export async function runTournamentLeague(
  request: TournamentLeagueRequest,
  shouldContinue: () => boolean = () => true
): Promise<TournamentLeagueResult> {
  if (
    !TOURNAMENT_LEAGUE_OBJECTIVES.includes(request.objective) ||
    !Number.isSafeInteger(request.pairs) ||
    request.pairs < 1 ||
    request.pairs > TOURNAMENT_PROMOTION_PAIRS ||
    !Number.isSafeInteger(request.seed) ||
    request.seed <= 0
  )
    throw new Error('Invalid tournament league request');
  const card = validateTournamentFlagRequest(request);
  if (request.flagQualification) {
    const { authenticateTournamentFlagExecution } =
      await import('./HorseTournamentFlagQualification.js');
    await authenticateTournamentFlagExecution(request);
  }
  const firstPair = request.firstPair ?? 0;
  const family = tournamentPolicyFamily(request.phase8PolicyFamily);
  const started = performance.now();
  const saved = saveFastRandom();
  const result: TournamentLeagueResult = {
    ...emptyTournamentCompletionCounts(),
    ...(card
      ? {
          flagCard: card.name,
          gameVariant: card.variant,
          firstPair,
          cardDecisions: 0,
          cardChanged: 0,
          cardPairs: [],
        }
      : {}),
    version: tournamentPolicyVersion(family),
    phase8PolicyFamily: family,
    workKind: tournamentPolicyWorkKind(family),
    ...(request.opponentPopulation
      ? { opponentPopulation: request.opponentPopulation, humanResponses: {} }
      : {}),
    candidateMode: request.candidateMode ?? 'candidate',
    evidenceMode: request.evidenceMode ?? 'fixture',
    objective: request.objective,
    entrants: tournamentLeagueEntrants(request.objective),
    seed: request.seed,
    requestedPairs: request.pairs,
    pairs: 0,
    complete: false,
    primaryMetric: request.objective === 'satellite' ? 'seat_attainment' : 'funded_pool_return',
    meanDifference: 0,
    standardError: 0,
    confidence99: [0, 0],
    candidateReturn: 0,
    baselineReturn: 0,
    chipDifference: 0,
    bountyDifference: 0,
    candidateBustRate: 0,
    baselineBustRate: 0,
    candidateFinish: Array(tournamentLeagueEntrants(request.objective)).fill(0),
    baselineFinish: Array(tournamentLeagueEntrants(request.objective)).fill(0),
    decisions: 0,
    eligible: 0,
    fired: 0,
    changed: 0,
    illegalActions: 0,
    conservationErrors: 0,
    truncatedHands: 0,
    candidateDeepOnePairCommitments: 0,
    baselineDeepOnePairCommitments: 0,
    preventedCommitments: 0,
    budgetExhaustions: 0,
    referenceRegret: 0,
    reference: 'phase7_action_utility_not_external_solver',
    latencyMs: { p50: 0, p95: 0, p99: 0, max: 0 },
    durationMs: 0,
    promotionEligible: false,
  };
  const differences: number[] = [];
  const latencies: number[] = [];
  try {
    for (let pair = 0; pair < request.pairs; pair++) {
      if (!shouldContinue()) break;
      const seed = (request.seed ^ Math.imul(firstPair + pair + 1, 2654435761)) >>> 0 || 1;
      const hero = (firstPair + pair) % tournamentLeagueEntrants(request.objective);
      const a = await playTournament(
        seed,
        request.objective,
        hero,
        request.candidateMode ?? 'candidate',
        shouldContinue,
        request.opponentPopulation ?? null,
        family,
        card ? { variant: card.variant, hero: card.a, counterfactual: card.b } : null
      );
      const b = await playTournament(
        seed,
        request.objective,
        hero,
        'off',
        shouldContinue,
        request.opponentPopulation ?? null,
        family,
        card ? { variant: card.variant, hero: card.b, counterfactual: null } : null
      );
      for (const arm of [a, b])
        for (const [node, counts] of Object.entries(arm.humanResponses))
          for (const [act, n] of Object.entries(counts)) {
            const into = ((result.humanResponses ??= {})[node] ??= {});
            into[act] = (into[act] ?? 0) + n;
          }
      result.illegalActions += a.illegal + b.illegal;
      result.conservationErrors += a.conservation + b.conservation;
      result.truncatedHands += a.truncated + b.truncated;
      if (!a.complete || !b.complete) break;
      result.pairs++;
      if (card) {
        result.cardDecisions! += a.cardDecisions ?? 0;
        result.cardChanged! += a.cardChanged ?? 0;
        result.cardPairs!.push({
          index: firstPair + pair,
          candidate: a.returned,
          reference: b.returned,
        });
      }
      differences.push(a.returned - b.returned);
      result.candidateReturn += a.returned;
      result.baselineReturn += b.returned;
      result.chipDifference += a.chips - b.chips;
      result.bountyDifference += a.bounty - b.bounty;
      result.candidateBustRate += Number(a.finish > 1);
      result.baselineBustRate += Number(b.finish > 1);
      result.candidateFinish[a.finish - 1]++;
      result.baselineFinish[b.finish - 1]++;
      result.decisions += a.decisions + b.decisions;
      mergeTournamentOpportunities(result, a);
      result.eligible += a.eligible;
      result.fired += a.fired;
      result.completed += a.completed;
      for (const [reason, count] of Object.entries(a.completionRefusals))
        result.completionRefusals[reason] = (result.completionRefusals[reason] ?? 0) + count;
      const availableRows =
        MAX_TOURNAMENT_COMPLETION_DIAGNOSTICS - result.completionDiagnostics.length;
      result.completionDiagnostics.push(...a.completionDiagnostics.slice(0, availableRows));
      result.completionDiagnosticsDropped +=
        a.completionDiagnosticsDropped +
        Math.max(0, a.completionDiagnostics.length - availableRows);
      result.changed += a.changed;
      result.candidateDeepOnePairCommitments += a.deep;
      result.baselineDeepOnePairCommitments += b.deep;
      result.preventedCommitments += a.prevented;
      result.budgetExhaustions += a.budget;
      result.referenceRegret += a.regret;
      latencies.push(...a.latency);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    restoreFastRandom(saved);
  }
  const n = result.pairs;
  if (n) {
    result.meanDifference = differences.reduce((s, x) => s + x, 0) / n;
    result.standardError =
      n > 1
        ? Math.sqrt(
            differences.reduce((s, x) => s + (x - result.meanDifference) ** 2, 0) / (n - 1) / n
          )
        : 0;
    result.confidence99 = pairedConfidence99(result.meanDifference, result.standardError, n);
    result.candidateReturn /= n;
    result.baselineReturn /= n;
    result.chipDifference /= n;
    result.bountyDifference /= n;
    result.candidateBustRate /= n;
    result.baselineBustRate /= n;
  }
  latencies.sort((a, b) => a - b);
  const quantile = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
  result.latencyMs = {
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    max: quantile(1),
  };
  result.durationMs = performance.now() - started;
  result.complete = n === request.pairs;
  result.promotionEligible = tournamentRunCanPromote(result);
  return result;
}

/** Two-sided 99% interval for paired differences. Tiny fixtures carry no claim.
 * 2.59 is conservative against t(.995,1023)=2.5806 at the promotion floor.
 * Lower sample runs use the full possible paired-return support [-1,1]. */
export function pairedConfidence99(
  mean: number,
  standardError: number,
  n: number
): [number, number] {
  if (n < TOURNAMENT_PROMOTION_PAIRS) return [-1, 1];
  const width = 2.59 * standardError;
  return [Math.max(-1, mean - width), Math.min(1, mean + width)];
}

/** Guard assessment has no partial continuation completion or work-budget refusal. */
export function tournamentGuardCountsAreValid(r: {
  phase8PolicyFamily?: unknown;
  eligible?: unknown;
  fired?: unknown;
  completed?: unknown;
  completionRefusals?: unknown;
  completionDiagnostics?: unknown;
  completionDiagnosticsDropped?: unknown;
  budgetExhaustions?: unknown;
}): boolean {
  if (r.phase8PolicyFamily !== 'catastrophe_guard_v1') return true;
  const rows = r.completionDiagnostics;
  const refusals = r.completionRefusals;
  if (
    typeof r.eligible !== 'number' ||
    !Number.isSafeInteger(r.eligible) ||
    r.eligible < 0 ||
    r.fired !== r.eligible ||
    r.completed !== r.eligible ||
    r.budgetExhaustions !== 0 ||
    !refusals ||
    typeof refusals !== 'object' ||
    Array.isArray(refusals) ||
    Object.keys(refusals).length !== 0 ||
    !Array.isArray(rows) ||
    typeof r.completionDiagnosticsDropped !== 'number' ||
    !Number.isSafeInteger(r.completionDiagnosticsDropped) ||
    r.completionDiagnosticsDropped < 0 ||
    rows.length + r.completionDiagnosticsDropped !== r.eligible
  )
    return false;
  return rows.every((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      row.completed !== true ||
      row.workKind !== 'phase7_candidate_guard'
    )
      return false;
    const work = row.guardWork;
    return (
      work &&
      typeof work === 'object' &&
      work.assessmentCompleted === true &&
      typeof work.candidateCount === 'number' &&
      Number.isSafeInteger(work.candidateCount) &&
      work.candidateCount >= 1 &&
      work.candidateCount <= 16
    );
  });
}

export function tournamentRunCanPromote(r: TournamentLeagueResult): boolean {
  if (r.flagCard !== undefined) return false; // separate immutable flag-card qualification only
  if (!tournamentGuardCountsAreValid(r)) return false;
  if (
    r.phase8PolicyFamily !== undefined &&
    !TOURNAMENT_POLICY_FAMILIES.includes(r.phase8PolicyFamily)
  )
    return false;
  if (r.phase8PolicyFamily === 'catastrophe_guard_v1' && r.workKind !== 'phase7_candidate_guard')
    return false;
  return (
    r.version === tournamentPolicyVersion(tournamentPolicyFamily(r.phase8PolicyFamily)) &&
    r.evidenceMode === 'promotion' &&
    r.candidateMode === 'candidate' &&
    r.complete &&
    r.pairs === r.requestedPairs &&
    r.pairs >= TOURNAMENT_PROMOTION_PAIRS &&
    r.entrants === tournamentLeagueEntrants(r.objective) &&
    r.candidateFinish.length === r.entrants &&
    r.baselineFinish.length === r.entrants &&
    pairedConfidence99(r.meanDifference, r.standardError, r.pairs)[0] > 0 &&
    r.confidence99.every(
      (v, i) =>
        Math.abs(v - pairedConfidence99(r.meanDifference, r.standardError, r.pairs)[i]) < 1e-8
    ) &&
    r.eligible >= r.fired &&
    r.completionSchemaVersion === 1 &&
    r.fired >= r.completed &&
    r.completed >= r.changed &&
    r.completed + Object.values(r.completionRefusals).reduce((sum, count) => sum + count, 0) ===
      r.eligible &&
    r.decisions >= r.eligible &&
    Math.abs(r.meanDifference - r.candidateReturn + r.baselineReturn) < 1e-8 &&
    r.candidateFinish.reduce((s, v) => s + v, 0) === r.pairs &&
    r.baselineFinish.reduce((s, v) => s + v, 0) === r.pairs &&
    r.illegalActions === 0 &&
    r.conservationErrors === 0 &&
    r.truncatedHands === 0 &&
    r.changed > 0 &&
    r.candidateDeepOnePairCommitments <= r.baselineDeepOnePairCommitments &&
    r.latencyMs.p99 <= PHASE8_POLICY.budgetMs
  );
}

export function summarizeTournamentPromotion(runs: TournamentLeagueResult[]) {
  const families = new Set(runs.map((r) => tournamentPolicyFamily(r.phase8PolicyFamily)));

  const reasons: string[] = [];
  if (families.size > 1) reasons.push('mixed_policy_families');
  const buckets = TOURNAMENT_LEAGUE_OBJECTIVES.map((objective) => {
    const group = runs.filter((r) => r.objective === objective);
    const seeds = group.map((r) => r.seed);
    if (
      group.length !== TOURNAMENT_PROMOTION_SEEDS.length ||
      !TOURNAMENT_PROMOTION_SEEDS.every((seed) => seeds.filter((s) => s === seed).length === 1)
    )
      reasons.push(`${objective}:missing_or_duplicate_seed`);
    for (const r of group)
      if (!tournamentRunCanPromote(r)) reasons.push(`${objective}:${r.seed}:not_promotable`);
    const n = group.reduce((s, r) => s + r.pairs, 0);
    const mean = n ? group.reduce((s, r) => s + r.meanDifference * r.pairs, 0) / n : 0;
    // Recover the paired sum of squares, including between-run variation.
    const ss = group.reduce(
      (s, r) =>
        s +
        r.standardError ** 2 * r.pairs * Math.max(0, r.pairs - 1) +
        r.pairs * (r.meanDifference - mean) ** 2,
      0
    );
    const se = n > 1 ? Math.sqrt(ss / (n - 1) / n) : 0;
    return {
      objective,
      pairs: n,
      meanDifference: mean,
      standardError: se,
      confidence99: pairedConfidence99(mean, se, n),
    };
  });
  if (runs.length !== TOURNAMENT_LEAGUE_OBJECTIVES.length * TOURNAMENT_PROMOTION_SEEDS.length)
    reasons.push('incomplete_run_matrix');
  return {
    ...(runs.some((r) => r.phase8PolicyFamily !== undefined)
      ? { phase8PolicyFamily: families.size === 1 ? [...families][0] : 'mixed' }
      : {}),
    promoted: reasons.length === 0,
    reasons,
    buckets,
  };
}

/** Software liveness is separate from strength promotion. A safe but entirely
 * silent candidate cannot pass the first-round baseline gate. */
export function tournamentBaselineRunVerified(run: TournamentLeagueResult): boolean {
  if (!tournamentGuardCountsAreValid(run)) return false;
  return (
    run.complete &&
    run.pairs === run.requestedPairs &&
    run.eligible > 0 &&
    run.fired > 0 &&
    run.completionSchemaVersion === 1 &&
    run.completed > 0 &&
    run.completed <= run.fired &&
    run.completed + Object.values(run.completionRefusals).reduce((sum, count) => sum + count, 0) ===
      run.eligible &&
    run.illegalActions === 0 &&
    run.conservationErrors === 0 &&
    run.truncatedHands === 0 &&
    run.latencyMs.p99 <= PHASE8_POLICY.budgetMs
  );
}
