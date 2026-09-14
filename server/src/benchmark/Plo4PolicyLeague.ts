import {
  REMAINING_VARIANT_PACKS,
  REMAINING_VARIANT_DOMAIN,
  isRemainingPolicyVariant,
  remainingVariantSeatCap,
  type RemainingPolicyVariant,
} from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import type { Card, HandConfig, HandEvent, HorseStyle, SeatPlayer } from '../types.js';
import { HandController } from '../engine/HandController.js';
import { HorseLogic, type HorseGameStateV2 } from '../engine/HorseLogic.js';
import { HorseMind } from '../engine/HorseMind.js';
import { restoreFastRandom, saveFastRandom, seedFastRandom } from '../engine/HorseEval.js';
import { calculateContestablePot } from '../engine/PokerEngine.js';
import { horseVariantRulesFor } from '../engine/VariantRules.js';
import {
  OMAHA_VARIANT_PACKS,
  omahaVariantSeatCap,
  type OmahaPolicyVariant,
} from '../engine/omaha/OmahaVariantPolicyPack.js';
import { PLO4_POLICY_PACK } from '../engine/plo4/Plo4PolicyPack.js';
import { referenceDeck, uniqueCards } from './OmahaReference.js';
import type { Plo4PolicyMode } from './Plo4PolicyProgram.js';
import { equityGovernor } from '../engine/EquityLoadGovernor.js';
import { equitySampleSizeOfLastCall, variantInfo } from '../engine/HorseEval.js';
import { gtoChartCount } from '../engine/GtoCharts.js';
import { gtoPostflopCount } from '../engine/GtoPostflop.js';
import { gtoPostflopV31Count, gtoPostflopV31Dataset } from '../engine/GtoPostflopV31.js';
import { JOINT_LIVE_DOMAIN } from '../engine/multiway/JointLivePolicy.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';
import { maxSeatsFor } from '../engine/VariantRules.js';
function assertFixedBudget() {
  if (
    process.env.EQUITY_GOVERNOR !== 'off' ||
    equityGovernor.snapshot().enabled ||
    equityGovernor.current() !== 1
  )
    throw new Error('PLO4 evidence requires EQUITY_GOVERNOR=off before module import and scale 1');
}
export function plo4LeagueSeating(index: number, seats: number) {
  const heroSeat = (index % seats) + 1;
  const button = (Math.floor(index / seats) % seats) + 1;
  return { heroSeat, button, relativePosition: (heroSeat - button + seats) % seats };
}

// Shared physical controller/paired accounting. Each variant supplies its own pack and fixed population.
export interface Plo4LeagueProfile {
  variant?: OmahaPolicyVariant | RemainingPolicyVariant | 'nlh' | 'plo4';
  jointPolicy?: boolean;
  bombBoards?: 1 | 2 | 3;
  asset?: 'chips' | 'diamonds';
  bbj?: boolean;
  id: string;
  seats: number;
  stackBB: number;
  rakePercent: number;
  rakeCapBB: number;
  anteBB: number;
  straddle: boolean;
  tournament: boolean;
  opponentStyle: HorseStyle;
}
/** Fixed first-round populations and seeds. Never select a seed after seeing its result. */
export const PLO4_LEAGUE_PROFILES: readonly Readonly<Plo4LeagueProfile>[] = Object.freeze([
  Object.freeze({
    id: 'heads-up-25bb',
    seats: 2,
    stackBB: 25,
    rakePercent: 5,
    rakeCapBB: 3,
    anteBB: 0,
    straddle: false,
    tournament: false,
    opponentStyle: 'balanced' as const,
  }),
  Object.freeze({
    id: 'six-max-100bb',
    seats: 6,
    stackBB: 100,
    rakePercent: 10,
    rakeCapBB: 5,
    anteBB: 0,
    straddle: false,
    tournament: false,
    opponentStyle: 'tag' as const,
  }),
  Object.freeze({
    id: 'straddle-ante-100bb',
    seats: 4,
    stackBB: 100,
    rakePercent: 10,
    rakeCapBB: 5,
    anteBB: 0.5,
    straddle: true,
    tournament: false,
    opponentStyle: 'lag' as const,
  }),
  Object.freeze({
    id: 'tournament-owner-30bb',
    seats: 3,
    stackBB: 30,
    rakePercent: 0,
    rakeCapBB: 0,
    anteBB: 0.5,
    straddle: false,
    tournament: true,
    opponentStyle: 'balanced' as const,
  }),
  Object.freeze({
    id: 'eight-max-50bb',
    seats: 8,
    stackBB: 50,
    rakePercent: 10,
    rakeCapBB: 5,
    anteBB: 0,
    straddle: false,
    tournament: false,
    opponentStyle: 'tag' as const,
  }),
  Object.freeze({
    id: 'heads-up-3bb',
    seats: 2,
    stackBB: 3,
    rakePercent: 5,
    rakeCapBB: 3,
    anteBB: 0,
    straddle: false,
    tournament: false,
    opponentStyle: 'balanced' as const,
  }),
]);
export const PLO4_LEAGUE_SEEDS = Object.freeze([10101101, 10102203, 10103307]);
const BB = 2;
function deckFor(seed: number, shortDeck = false): Card[] {
  const deck = referenceDeck().filter((c) => !shortDeck || !'2345'.includes(c.rank));
  let value = seed >>> 0 || 1;
  for (let i = deck.length - 1; i > 0; i--) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    const j = Math.floor(((value >>> 0) / 4294967296) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
export interface Plo4HandReceipt {
  joint?: {
    seen: number;
    fired: number;
    utilityEvaluated: number;
    utilityUnavailable: number;
    boards: Record<string, number>;
    opponents: Record<string, number>;
  };
  complete: boolean;
  net: number[];
  rake: number;
  bbj: number;
  decisions: number;
  equityWork: Record<string, number>;
  eligible: number;
  changed: number;
  illegalActions: number;
  conservationErrors: number;
  cardErrors: number;
  truncated: number;
  nodeCounts: Record<string, number>;
  reasons: Record<string, number>;
}
export async function playPlo4PolicyHand(
  profile: Plo4LeagueProfile,
  seed: number,
  button: number,
  heroSeat: number,
  mode: Plo4PolicyMode,
  samples: number,
  shouldContinue = () => true
): Promise<Plo4HandReceipt> {
  const variant = profile.variant ?? 'plo4';
  const remainingVariant = isRemainingPolicyVariant(variant);
  const receipt: Plo4HandReceipt = {
    ...(profile.jointPolicy
      ? {
          joint: {
            seen: 0,
            fired: 0,
            utilityEvaluated: 0,
            utilityUnavailable: 0,
            boards: {},
            opponents: {},
          },
        }
      : {}),
    complete: false,
    net: [],
    rake: 0,
    bbj: 0,
    decisions: 0,
    equityWork: {},
    eligible: 0,
    changed: 0,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    truncated: 0,
    nodeCounts: {},
    reasons: {},
  };
  const players: SeatPlayer[] = Array.from({ length: profile.seats }, (_, index) => ({
    seat: index + 1,
    user_id: `plo4-league-${index + 1}`,
    username: `Seat ${index + 1}`,
    stack: profile.stackBB * BB,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  }));
  const config: HandConfig = {
    tableId: `${remainingVariant ? 'phase12' : profile.variant ? 'phase11' : 'phase10'}-offline-league`,
    handNumber: 1,
    gameVariant: variant,
    smallBlind: 1,
    bigBlind: BB,
    ante: profile.anteBB * BB,
    isTournament: profile.tournament,
    rakeConfig: { percent: profile.rakePercent, cap: profile.rakeCapBB * BB, noFlopNoDrop: true },
    ...(profile.jointPolicy
      ? {
          asset: profile.asset ?? 'chips',
          ...(profile.bombBoards
            ? { bombPot: { anteMultiplier: 2, boardCount: profile.bombBoards } }
            : {}),
          ...(profile.bbj
            ? { bbjConfig: { enabled: true, feeBB: 0.5, minPlayersDealt: 2, minPotBB: 0 } }
            : {}),
        }
      : {}),
    ...(profile.straddle
      ? { straddles: [{ seat: ((button + 2) % profile.seats) + 1, amount: BB * 2 }] }
      : {}),
  };
  const controller = new HandController(config, players, button);
  // Only this offline controller's instance receives the fixed deck. No global
  // shuffle, live controller, persistent service or opponent memory is touched.
  const deck = deckFor(seed, variant === 'short_deck');
  const instance = controller.getState().deck as unknown as {
    deal(n?: number): Card[];
    dealOne(): Card;
    remaining(): number;
    getRemainingCards(): Card[];
  };
  instance.deal = (n = 1) => {
    if (deck.length < n) throw new Error('PLO4 league exhausted deck');
    return deck.splice(0, n);
  };
  instance.dealOne = () => instance.deal(1)[0];
  instance.remaining = () => deck.length;
  instance.getRemainingCards = () => deck.slice();
  let finished = false,
    runout = false;
  controller.onEvent((event: HandEvent) => {
    if (event.type === 'ALL_IN_RUNOUT') runout = true;
    if (event.type === 'HAND_COMPLETE') {
      finished = true;
      receipt.rake = event.rake;
      receipt.bbj = event.bbjFee;
    }
  });
  const sandbox = HorseMind.createSandbox();
  const rng = saveFastRandom();
  try {
    controller.start();
    for (
      let step = 0;
      step <
        (remainingVariant
          ? REMAINING_VARIANT_DOMAIN.maxActionsPerHand
          : PLO4_POLICY_PACK.maxActionsPerHand) && !finished;
      step++
    ) {
      if (!shouldContinue()) return receipt;
      if (runout) {
        runout = false;
        if (variant === 'pineapple') {
          const pending = controller.getPineappleRunoutDiscardSnapshot();
          if (pending) {
            const decisions = new Map(
              pending.players.map((p) => {
                seedFastRandom((seed ^ Math.imul(p.seat, 1009) ^ 120012) >>> 0 || 1);
                return [p.seat, HorseLogic.decideDiscard(p.cards, pending.flop, variant)];
              })
            );
            if (!controller.preparePineappleRunoutDiscards(pending.flop, decisions)) {
              receipt.illegalActions++;
              return receipt;
            }
          }
        }
        controller.continueRunout();
        continue;
      }
      const state = controller.getState();
      if (variant === 'pineapple' && state.stage === 'pineapple_discard') {
        for (const p of state.players.filter((p) => !p.is_folded && p.cards.length === 3)) {
          seedFastRandom((seed ^ Math.imul(p.seat, 1009) ^ 120012) >>> 0 || 1);
          const discard = HorseLogic.decideDiscard(
            p.cards,
            state.communityCards.slice(0, 3),
            variant
          );
          if (!controller.performDiscard(p.seat, discard)) {
            receipt.illegalActions++;
            return receipt;
          }
        }
        // This offline driver has no animation clock; use the controller's
        // existing fuzzer bridge after every real discard has been accepted.
        controller.flushPineappleSettle();
        continue;
      }
      const hero = state.players.find((p) => p.seat === state.currentPlayerSeat);
      if (!hero) {
        receipt.truncated++;
        return receipt;
      }
      if (variant === 'pineapple')
        hero.knownDeadCards = controller.getPineappleKnownDeadCards(hero.seat);
      const menu = controller.getAuthoritativeActionState(hero.user_id);
      if (!menu?.canAct) {
        receipt.truncated++;
        return receipt;
      }
      const gs: HorseGameStateV2 = {
        players: state.players.map((p) => ({
          ...p,
          cards: [],
          ...(variant === 'pineapple' ? { knownDeadCards: undefined } : {}),
        })),
        communityCards: state.communityCards,
        ...(profile.jointPolicy
          ? {
              communityCards2: state.communityCards2,
              communityCards3: state.communityCards3,
              bombPot: Boolean(profile.bombBoards),
              boardCount: controller.getActiveBoardCount(),
              dealtSeatIds: state.players.filter((p) => p.cards.length > 0).map((p) => p.seat),
              ...controller.getChipRulesSnapshot(),
            }
          : {}),
        pot: state.pot,
        currentBet: state.currentBet,
        stage: state.stage,
        minRaise: state.minRaise,
        lastRaise: state.lastRaise,
        dealerSeat: state.dealerSeat,
        stateSchemaVersion: 1,
        heroSeat: hero.seat,
        currentPlayerSeat: hero.seat,
        gameMode: profile.tournament ? 'tournament' : 'cash',
        format: profile.tournament ? 'sng' : 'cash',
        gameVariant: variant,
        bigBlind: BB,
        ante: config.ante,
        straddleActive: profile.straddle,
        ...(!profile.jointPolicy ? { boardCount: 1 } : {}),
        legalActions: menu.legalActions,
        toCall: menu.toCall,
        minRaiseTo: menu.minRaiseTo,
        maxRaiseTo: menu.maxRaiseTo,
        bettingStructure: menu.structure,
        ...(remainingVariant
          ? { fixedBetSize: menu.fixedBetSize, wagersCapped: menu.wagersCapped }
          : {}),
        pots: controller.computeLivePots(),
        contestablePot: calculateContestablePot(state.players, hero.user_id, menu.toCall),
        variantRules: horseVariantRulesFor(variant),
        rakeConfig: config.rakeConfig,
        actionHistory: state.actionHistory.map((a, i) => ({ ...a, timestamp: i + 1 })),
        ...(profile.tournament
          ? {
              tournament: {
                schemaVersion: 1,
                contextStatus: 'complete',
                contextIssues: [],
                currentSmallBlind: 1,
                currentBigBlind: BB,
                currentAnte: config.ante ?? 0,
                anteType: (config.ante ?? 0) > 0 ? 'per_player' : 'none',
                prizePoolCents: 10000,
                bountyPoolCents: 0,
                isPko: false,
                isBounty: false,
                isMysteryBounty: false,
                mysteryBountyStage: 'none',
                reentryOpen: false,
                rebuyOpen: false,
                addOnPeriodOpen: false,
                maxReentries: 0,
                maxRebuys: 0,
                reloadsUsed: 0,
                addOnTaken: false,
                rebuyAffordable: false,
                addOnAffordable: false,
                playersLeft: profile.seats,
                spotsPaid: 2,
                payoutPct: [65, 35],
                stacks: state.players.map((p) => p.stack + p.totalInvested),
                stackByUser: Object.fromEntries(
                  state.players.map((p) => [p.user_id, p.stack + p.totalInvested])
                ),
              },
            }
          : {}),
      };
      const actionSeed =
        (seed ^ Math.imul(step + 1, 104729) ^ Math.imul(hero.seat, 1009)) >>> 0 || 1;
      seedFastRandom(actionSeed);
      assertFixedBudget();
      const baseline = HorseMind.runInSandbox(sandbox, () =>
        HorseLogic.decide(
          hero,
          gs,
          hero.seat === heroSeat ? 'balanced' : profile.opponentStyle,
          {},
          {
            mind: true,
            telemetry: false,
            decisionTimeMs: 0,
            v9Mood: false,
            phase8Postflop: 'off',
            phase10Plo4:
              !profile.jointPolicy && !profile.variant && hero.seat === heroSeat ? mode : 'off',
            phase10EvidenceMode: true,
            phase11Omaha:
              !profile.jointPolicy && profile.variant && !remainingVariant && hero.seat === heroSeat
                ? mode
                : 'off',
            phase11EvidenceMode: true,
            phase12Remaining:
              !profile.jointPolicy && remainingVariant && hero.seat === heroSeat ? mode : 'off',
            phase12EvidenceMode: true,
            phase13Joint: profile.jointPolicy && hero.seat === heroSeat ? mode : 'off',
            phase13EvidenceMode: true,
          }
        )
      );
      const selected = baseline;
      if (gs.stage !== 'preflop') {
        const work = String(equitySampleSizeOfLastCall());
        receipt.equityWork[work] = (receipt.equityWork[work] ?? 0) + 1;
      }
      const policy = profile.jointPolicy
        ? baseline.jointPolicy
        : remainingVariant
          ? baseline.remainingVariantPolicy
          : profile.variant
            ? baseline.omahaVariantPolicy
            : baseline.plo4Policy;
      if (hero.seat === heroSeat && policy) {
        if (receipt.joint && baseline.jointPolicy) {
          const j = baseline.jointPolicy,
            r = receipt.joint;
          r.seen++;
          r.fired += Number(j.fired);
          r.utilityEvaluated += Number(j.utilityOwner === 'phase7_evaluated');
          r.utilityUnavailable += Number(j.utilityOwner === 'phase7_unavailable');
          r.boards[j.boardCount] = (r.boards[j.boardCount] ?? 0) + 1;
          r.opponents[j.liveOpponents] = (r.opponents[j.liveOpponents] ?? 0) + 1;
        }
        receipt.eligible += Number(policy.eligible);
        receipt.changed += Number(policy.applied);
        const node = `${gs.gameMode}/${gs.stage}/${'role' in policy ? policy.role : profile.jointPolicy ? 'joint-board-' + gs.boardCount : 'outside_domain'}`;
        receipt.nodeCounts[node] = (receipt.nodeCounts[node] ?? 0) + 1;
        receipt.reasons[policy.reason] = (receipt.reasons[policy.reason] ?? 0) + 1;
      }
      if (!shouldContinue()) return receipt;
      receipt.decisions++;
      if (
        !menu.legalActions.includes(selected.action) ||
        !controller.performAction(hero.seat, selected.action, selected.amount)
      ) {
        receipt.illegalActions++;
        return receipt;
      }
    }
    if (!finished) {
      receipt.truncated++;
      return receipt;
    }
    const end = controller.getState();
    try {
      const physical = [
        ...end.players.flatMap((p) => [
          ...p.cards,
          ...controller.getPineappleKnownDeadCards(p.seat),
        ]),
        ...end.communityCards,
        ...(profile.jointPolicy
          ? [...(end.communityCards2 ?? []), ...(end.communityCards3 ?? [])]
          : []),
      ];
      uniqueCards(physical);
      if (variant === 'short_deck' && physical.some((c) => '2345'.includes(c.rank)))
        throw new Error('Invalid short-deck rank');
    } catch {
      receipt.cardErrors++;
    }
    receipt.net = end.players.map((p) => p.stack - profile.stackBB * BB);
    if (Math.abs(receipt.net.reduce((sum, n) => sum + n, 0) + receipt.rake + receipt.bbj) > 0.011)
      receipt.conservationErrors++;
    receipt.complete = !receipt.cardErrors && !receipt.conservationErrors;
    return receipt;
  } finally {
    controller.cancelPineappleSettle();
    restoreFastRandom(rng);
  }
}

export async function runOmahaPolicyLeague(
  options: {
    profileId: string;
    pairs: number;
    seed: number;
    mode?: Plo4PolicyMode;
    samples?: number;
  },
  shouldContinue = () => true,
  profiles: readonly Readonly<Plo4LeagueProfile>[] = PLO4_LEAGUE_PROFILES
) {
  const profile = profiles.find((p) => p.id === options.profileId);
  if (
    !profile ||
    (profile.variant &&
      (profile.seats < 2 ||
        profile.seats >
          (profile.jointPolicy
            ? profile.tournament
              ? Math.min(10, maxSeatsFor(profile.variant))
              : maxSeatsForVariant(profile.variant)
            : isRemainingPolicyVariant(profile.variant)
              ? remainingVariantSeatCap(profile.variant, profile.tournament ? 'tournament' : 'cash')
              : omahaVariantSeatCap(
                  profile.variant as OmahaPolicyVariant,
                  profile.tournament ? 'tournament' : 'cash'
                )))) ||
    !Number.isInteger(options.pairs) ||
    options.pairs < 1 ||
    options.pairs > PLO4_POLICY_PACK.maxPairs ||
    !Number.isInteger(options.seed) ||
    options.seed < 1 ||
    options.seed > 0xffffffff ||
    !['off', 'shadow', 'candidate'].includes(options.mode ?? 'candidate') ||
    !Number.isInteger(options.samples ?? 32) ||
    (options.samples ?? 32) < 1 ||
    (options.samples ?? 32) > 128
  )
    throw new Error('Invalid bounded PLO4 league request');
  const pairs: {
    seed: number;
    heroSeat: number;
    button: number;
    candidate: Plo4HandReceipt;
    baseline: Plo4HandReceipt;
    differenceBb: number;
  }[] = [];
  const incompleteHands: Plo4HandReceipt[] = [];
  for (let i = 0; i < options.pairs; i++) {
    if (!shouldContinue()) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const seed = (options.seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
    const { heroSeat, button } = plo4LeagueSeating(i, profile.seats);
    const candidate = await playPlo4PolicyHand(
      profile,
      seed,
      button,
      heroSeat,
      options.mode ?? 'candidate',
      options.samples ?? 32,
      shouldContinue
    );
    if (!candidate.complete) {
      incompleteHands.push(candidate);
      break;
    }
    const baseline = await playPlo4PolicyHand(
      profile,
      seed,
      button,
      heroSeat,
      'off',
      options.samples ?? 32,
      shouldContinue
    );
    if (!baseline.complete) {
      incompleteHands.push(candidate, baseline);
      break;
    }
    pairs.push({
      seed,
      heroSeat,
      button,
      candidate,
      baseline,
      differenceBb: (candidate.net[heroSeat - 1] - baseline.net[heroSeat - 1]) / BB,
    });
  }
  const count = pairs.length;
  const mean = count ? pairs.reduce((sum, p) => sum + p.differenceBb, 0) / count : null;
  const bound = profile.seats * profile.stackBB;
  const width = count ? bound * Math.sqrt((2 * Math.log(200)) / count) : bound;
  const interval =
    mean === null
      ? [-bound, bound]
      : [Math.max(-bound, mean - width), Math.min(bound, mean + width)];
  const all = [...pairs.flatMap((p) => [p.candidate, p.baseline]), ...incompleteHands];
  return {
    version: profile.jointPolicy
      ? JOINT_LIVE_DOMAIN.version
      : profile.variant
        ? (isRemainingPolicyVariant(profile.variant)
            ? REMAINING_VARIANT_PACKS[profile.variant]
            : OMAHA_VARIANT_PACKS[profile.variant as OmahaPolicyVariant]
          ).version
        : PLO4_POLICY_PACK.version,
    fixedWork: {
      governor: 'off',
      scale: 1,
      requestedBaselineIterations: variantInfo(profile.variant ?? 'plo4').iterations,
      policyClock: 'fixed_work_no_wall_clock_branch',
      runtimeStores: {
        charts: gtoChartCount(),
        postflop: gtoPostflopCount(),
        certified: gtoPostflopV31Count(),
        dataset: gtoPostflopV31Dataset(),
      },
    },
    relativePositions: [
      ...new Set(pairs.map((p) => (p.heroSeat - p.button + profile.seats) % profile.seats)),
    ].sort((a, b) => a - b),
    profile,
    seed: options.seed,
    mode: options.mode ?? 'candidate',
    complete: count === options.pairs,
    positionCoverageComplete:
      new Set(pairs.map((p) => (p.heroSeat - p.button + profile.seats) % profile.seats)).size ===
      profile.seats,
    requestedPairs: options.pairs,
    completedPairs: count,
    meanAfterRakeDifferenceBbPerHand: mean,
    confidence99: interval,
    confidenceMethod: 'bounded_paired_hoeffding' as const,
    metricScope: profile.tournament
      ? 'single_hand_chip_ev_only_not_tournament_prize_ev'
      : 'matched_hero_after_rake_chip_ev',
    promotionEligible: false,
    populationRangeModel: profile.variant
      ? 'variant_sequential_public_line_prior_and_HorseMind_opponents_uncalibrated'
      : 'public_line_conditioned_HorseMind_population_prior_uncalibrated',
    changed: all.reduce((s, h) => s + h.changed, 0),
    illegalActions: all.reduce((s, h) => s + h.illegalActions, 0),
    conservationErrors: all.reduce((s, h) => s + h.conservationErrors, 0),
    cardErrors: all.reduce((s, h) => s + h.cardErrors, 0),
    truncatedHands: all.reduce((s, h) => s + h.truncated, 0),
    totalRake: all.reduce((s, h) => s + h.rake, 0),
    pairs,
    incompleteHands,
  };
}

/** Phase 10 population and results remain fixed; Phase 11 uses the shared controller through its own registry. */
export function runPlo4PolicyLeague(
  options: Parameters<typeof runOmahaPolicyLeague>[0],
  shouldContinue = () => true
) {
  return runOmahaPolicyLeague(options, shouldContinue);
}
