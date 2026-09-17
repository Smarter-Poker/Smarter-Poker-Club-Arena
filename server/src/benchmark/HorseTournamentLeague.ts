/** Paired whole tournaments through the real controller, inside the league process. */
import { HandController } from '../engine/HandController.js';
import { HorseLogic, type HorseGameStateV2 } from '../engine/HorseLogic.js';
import { HorseMind } from '../engine/HorseMind.js';
import { saveFastRandom, restoreFastRandom, seedFastRandom } from '../engine/HorseEval.js';
import { calculateContestablePot, RANKS, SUITS } from '../engine/PokerEngine.js';
import { horseVariantRulesFor } from '../engine/VariantRules.js';
import { buildTournamentMState } from '../engine/HorseTournamentPreflop.js';
import { attributeKnockout } from '../tournament/knockoutAttribution.js';
import {
  deepOnePairCommitment,
  PHASE8_POLICY,
  type Phase8Mode,
  type HorseTournamentPostflopLedger,
} from '../engine/HorseTournamentPostflop.js';
import type { Card, HandEvent, SeatPlayer, Winner, PerPotAward } from '../types.js';

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

export interface TournamentLeagueRequest {
  objective: TournamentLeagueObjective;
  pairs: number;
  seed: number;
  /** Test mirror; production promotion always compares candidate with off. */
  candidateMode?: Phase8Mode;
  evidenceMode?: 'fixture' | 'promotion';
}
export const MAX_TOURNAMENT_COMPLETION_DIAGNOSTICS = 256;
export interface TournamentCompletionDiagnostic {
  street: string;
  localPlayers: number;
  fieldPlayers: number;
  completed: boolean;
  reason: string;
  latencyMs: number;
  work: HorseTournamentPostflopLedger['work'];
}
export interface TournamentCompletionCounts {
  completionSchemaVersion: 1;
  completed: number;
  completionRefusals: Record<string, number>;
  completionDiagnostics: TournamentCompletionDiagnostic[];
  completionDiagnosticsDropped: number;
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
  layer: HorseTournamentPostflopLedger,
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
  version: typeof PHASE8_POLICY.version;
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
}

async function playTournament(
  seed: number,
  objective: TournamentLeagueObjective,
  heroSeat: number,
  mode: Phase8Mode,
  shouldContinue: () => boolean
): Promise<Receipt> {
  const count = tournamentLeagueEntrants(objective);
  const startStack = 2000;
  const players = Array.from({ length: count }, (_, i) => seat(i, startStack));
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
    const bigBlind = 10 * 2 ** level;
    const ante = level >= 2 ? Math.round(bigBlind / 10) : 0;
    const starts = new Map(alive.map((p) => [p.user_id, p.stack]));
    const totalBefore = alive.reduce((sum, p) => sum + p.stack, 0);
    const config = {
      tableId: 'phase8-tournament-league',
      handNumber: hand + 1,
      gameVariant: 'nlh' as const,
      isTournament: true,
      smallBlind: bigBlind / 2,
      bigBlind,
      ante,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    };
    const controller = new HandController(config, tablePlayers, dealerSeat);
    // Replace methods only on this isolated controller's deck instance. No
    // production shuffle, prototype, flag or live object is changed. Every
    // original seat retains identical holes and board even after paths diverge.
    const full = cardsFor((seed ^ Math.imul(hand + 1, 2654435761)) >>> 0);
    const fixedBoard = full.slice(count * 2, count * 2 + 5);
    const deck = tablePlayers
      .flatMap((p) => {
        const i = originalIds.indexOf(p.user_id);
        return full.slice(i * 2, i * 2 + 2);
      })
      .concat(fixedBoard, full.slice(count * 2 + 5));
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
        currentSmallBlind: bigBlind / 2,
        currentBigBlind: bigBlind,
        currentAnte: ante,
        anteType: ante > 0 ? 'per_player' : 'none',
        playersAtTable: state.players.length,
        seatsPerTable: 6,
        nextSmallBlind: bigBlind,
        nextBigBlind: bigBlind * 2,
        nextAnte: Math.round(bigBlind / 5),
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
        smallBlind: bigBlind / 2,
        bigBlind,
        ante,
        anteType: tournament.anteType!,
        playersAtTable: state.players.length,
        nextSmallBlind: bigBlind,
        nextBigBlind: bigBlind * 2,
        nextAnte: Math.round(bigBlind / 5),
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
        gameVariant: 'nlh',
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
        variantRules: horseVariantRulesFor('nlh'),
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
      const decision = HorseMind.runInSandbox(sandbox, () =>
        HorseLogic.decide(
          hero,
          gs,
          'balanced',
          {},
          {
            phase8Postflop: hero.user_id === heroId ? mode : 'off',
            mind: false,
            telemetry: false,
            decisionTimeMs: 0,
          }
        )
      );
      receipt.decisions++;
      const layer = decision.tournamentPostflop;
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
        if (!attribution.claimants.length) {
          receipt.conservation++;
          return receipt;
        }
        const bounty = objective === 'pko' ? (heads.get(p.user_id) ?? 0) : 1000;
        for (const claimant of attribution.claimants) {
          const paid = bounty * claimant.weight * (objective === 'pko' ? 0.5 : 1);
          paidBounties += paid;
          if (claimant.userId === heroId) receipt.bounty += paid;
          if (objective === 'pko')
            heads.set(claimant.userId, (heads.get(claimant.userId) ?? 0) + paid);
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
  const started = performance.now();
  const saved = saveFastRandom();
  const result: TournamentLeagueResult = {
    ...emptyTournamentCompletionCounts(),
    version: PHASE8_POLICY.version,
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
      const seed = (request.seed ^ Math.imul(pair + 1, 2654435761)) >>> 0 || 1;
      const hero = pair % tournamentLeagueEntrants(request.objective);
      const a = await playTournament(
        seed,
        request.objective,
        hero,
        request.candidateMode ?? 'candidate',
        shouldContinue
      );
      const b = await playTournament(seed, request.objective, hero, 'off', shouldContinue);
      result.illegalActions += a.illegal + b.illegal;
      result.conservationErrors += a.conservation + b.conservation;
      result.truncatedHands += a.truncated + b.truncated;
      if (!a.complete || !b.complete) break;
      result.pairs++;
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

export function tournamentRunCanPromote(r: TournamentLeagueResult): boolean {
  return (
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
  const reasons: string[] = [];
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
  return { promoted: reasons.length === 0, reasons, buckets };
}

/** Software liveness is separate from strength promotion. A safe but entirely
 * silent candidate cannot pass the first-round baseline gate. */
export function tournamentBaselineRunVerified(run: TournamentLeagueResult): boolean {
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
