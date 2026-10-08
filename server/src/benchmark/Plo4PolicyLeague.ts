import {
  REMAINING_VARIANT_PACKS,
  REMAINING_VARIANT_DOMAIN,
  isRemainingPolicyVariant,
  remainingVariantSeatCap,
  type RemainingPolicyVariant,
} from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import type {
  Card,
  HandConfig,
  HandEvent,
  HorseDecision,
  HorseStyle,
  SeatPlayer,
} from '../types.js';
import {
  HUMAN_CALIBRATED_POPULATION_ID,
  HUMAN_CALIBRATED_STRENGTH_BINS,
  humanCalibratedDecide,
  humanCalibratedFamily,
  type HumanCalibratedProfile,
  type HumanCalibratedSpot,
} from './HumanCalibratedPopulation.js';
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
import { createHash } from 'node:crypto';
import {
  contributionLayers,
  referenceDeck,
  settleOmahaReference,
  uniqueCards,
} from './OmahaReference.js';
import { effectiveBbjDrop, effectiveRake } from '../config/rakeSpec.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import {
  PLO4_DIVERGENCE_STREETS,
  PLO4_STRENGTH_BB,
  PLO4_STRENGTH_CONTRACT,
  Plo4PowerAccumulator,
  isPlo4HoldoutSeed,
  plo4StrengthContractDigest,
  plo4StrengthProfile,
  plo4StrengthSeatStyle,
  type Plo4DivergenceStreet,
  type Plo4StrengthShardResult,
} from './Plo4StrengthContract.js';
import {
  isOmahaVariantHoldoutSeed,
  omahaVariantMoodClockMs,
} from './OmahaVariantStrengthContract.js';
import type { OmahaVariant } from './OmahaReference.js';
import { isRemainingVariantHoldoutSeed } from './RemainingVariantStrengthContract.js';
import { remainingVariantIndependentHandChecks } from './RemainingVariantStrengthChecks.js';
import { isJointHoldoutSeed, type JointStrengthVariant } from './JointStrengthContract.js';
import { jointIndependentHandChecks } from './JointStrengthChecks.js';
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
  /** P10.2 contract profiles: the table's max_players (cap ladder). */
  tableSeats?: number;
  /** P10.2: price the hand with the engine's published PLO4 1/2 rake, cap
   * ladder and BBJ drop instead of rakePercent/rakeCapBB. */
  publishedRake?: boolean;
  /** P10.2: every seat, hero included, takes its production style from
   * plo4StrengthSeatStyle(dealSeed, seat) instead of balanced/opponentStyle. */
  productionStyles?: boolean;
  /** P11.2: v9 mood on in every seat and both arms, on the deterministic
   * decision clock omahaVariantMoodClockMs(dealSeed). Absent (every PLO4 and
   * earlier profile): mood off at decisionTimeMs 0, exactly as before. */
  moodClock?: 'deal_seed_time_of_day';
  /** WIN-POP 2026-10-08: every non-hero seat plays the human-calibrated
   * population (HumanCalibratedPopulation.ts) instead of HorseLogic. Absent on
   * every existing profile, which keeps the production horse population. */
  opponentPopulation?: typeof HUMAN_CALIBRATED_POPULATION_ID;
  /** Development fitting only (server/src/scripts/humanCalibratedFit.ts): the
   * human-calibrated profiles to play instead of the committed ones. */
  humanCalibratedProfiles?: readonly Readonly<HumanCalibratedProfile>[];
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
/** P10.2 per-hand independent checks, recorded only for contract hands. */
export interface Plo4HandChecks {
  trace: string[];
  settlementMismatches: number;
  deductionMismatches: number;
  showdownChecked: boolean;
  foldWinChecked: boolean;
  /** P11.2: set only when the independent reference awarded a low half. */
  lowHalfChecked?: boolean;
  /** P12.2: Pineapple discards in the trace (Phase 12 profiles only). */
  discards?: number;
  /** P13.2: set when a joint showdown was settled on two or three boards. */
  multiBoardChecked?: boolean;
}
export interface Plo4HandReceipt {
  checks?: Plo4HandChecks;
  joint?: {
    seen: number;
    fired: number;
    utilityEvaluated: number;
    utilityUnavailable: number;
    boards: Record<string, number>;
    opponents: Record<string, number>;
    /** P13.2: hero decisions the joint acquisition admitted, by board count. */
    eligibleByBoards?: Record<string, number>;
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
  /** P12.2, Phase 12 profiles only: hero candidate proposals the HorseLogic
   * selection guard refused (`illegal_candidate`); the reference was played. */
  illegalCandidates?: number;
  /** P13.2, joint profiles only: hero candidate proposals refused as
   * `earlier_phase_applied` (a Phase 13 candidate on an applied earlier one). */
  earlierPhaseRefusals?: number;
  /** WIN-POP, human-calibrated profiles only: the human seats' actions by
   * decision node (preflop/unopened, flop/facing_bet, ...), so a run can
   * report how closely the table played the measured frequencies. */
  humanCalibrated?: Record<string, Record<string, number>>;
  /** WIN-POP: the human seats' strength percentiles by node, in
   * HUMAN_CALIBRATED_STRENGTH_BINS equal bins (fitting and fidelity only). */
  humanCalibratedStrength?: Record<string, number[]>;
}
export async function playPlo4PolicyHand(
  profile: Plo4LeagueProfile,
  seed: number,
  button: number,
  heroSeat: number,
  mode: Plo4PolicyMode,
  shouldContinue = () => true,
  contractChecks = false
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
    ...(remainingVariant ? { illegalCandidates: 0 } : {}),
    // P13.2: the joint guard counters ride the contract shard runner only, so
    // the development joint league's receipts are unchanged.
    ...(profile.jointPolicy && contractChecks
      ? { illegalCandidates: 0, earlierPhaseRefusals: 0 }
      : {}),
    ...(profile.opponentPopulation ? { humanCalibrated: {}, humanCalibratedStrength: {} } : {}),
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
    ...(profile.publishedRake ? publishedCashPricing(profile) : {}),
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
        blindSeats: controller.getBlindSeatsSnapshot(),
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
      const humanSeat =
        profile.opponentPopulation === HUMAN_CALIBRATED_POPULATION_ID && hero.seat !== heroSeat;
      const baseline: HorseDecision = humanSeat
        ? humanCalibratedSeatDecision(hero, state, menu, variant, profile, receipt)
        : HorseMind.runInSandbox(sandbox, () =>
            HorseLogic.decide(
              hero,
              gs,
              profile.productionStyles
                ? plo4StrengthSeatStyle(seed, hero.seat)
                : hero.seat === heroSeat
                  ? 'balanced'
                  : profile.opponentStyle,
              {},
              {
                mind: true,
                telemetry: false,
                decisionTimeMs: profile.moodClock ? omahaVariantMoodClockMs(seed) : 0,
                v9Mood: Boolean(profile.moodClock),
                phase8Postflop: 'off',
                phase10Plo4:
                  !profile.jointPolicy && !profile.variant && hero.seat === heroSeat ? mode : 'off',
                phase10EvidenceMode: true,
                phase11Omaha:
                  !profile.jointPolicy &&
                  profile.variant &&
                  !remainingVariant &&
                  hero.seat === heroSeat
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
          if (j.eligible && contractChecks) {
            r.eligibleByBoards ??= {};
            r.eligibleByBoards[j.boardCount] = (r.eligibleByBoards[j.boardCount] ?? 0) + 1;
          }
        }
        receipt.eligible += Number(policy.eligible);
        receipt.changed += Number(policy.applied);
        if (receipt.illegalCandidates !== undefined && 'selectionRefusal' in policy)
          receipt.illegalCandidates += Number(policy.selectionRefusal === 'illegal_candidate');
        if (receipt.earlierPhaseRefusals !== undefined && 'selectionRefusal' in policy)
          receipt.earlierPhaseRefusals += Number(
            policy.selectionRefusal === 'earlier_phase_applied'
          );
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
    if (contractChecks)
      receipt.checks = profile.jointPolicy
        ? // P13.2: every physical board, every variant (JointBoardReference).
          jointIndependentHandChecks(variant as JointStrengthVariant, {
            end,
            startStack: profile.stackBB * BB,
            rake: receipt.rake,
            bbj: receipt.bbj,
            config,
            publishedRake: Boolean(profile.publishedRake),
            tableSeats: profile.tableSeats ?? profile.seats,
            boardCount: controller.getActiveBoardCount(),
            knownDeadCards: end.players.flatMap((p) =>
              controller.getPineappleKnownDeadCards(p.seat)
            ),
          })
        : remainingVariant
          ? remainingVariantIndependentHandChecks(variant, {
              end,
              startStack: profile.stackBB * BB,
              rake: receipt.rake,
              bbj: receipt.bbj,
              config,
              publishedRake: Boolean(profile.publishedRake),
              tableSeats: profile.tableSeats ?? profile.seats,
              knownDeadCards: end.players.flatMap((p) =>
                controller.getPineappleKnownDeadCards(p.seat)
              ),
            })
          : plo4IndependentHandChecks(profile, end, receipt, config);
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
  },
  shouldContinue = () => true,
  profiles: readonly Readonly<Plo4LeagueProfile>[] = PLO4_LEAGUE_PROFILES
) {
  if ('samples' in options)
    throw new Error(
      'League sample overrides are unsupported; the frozen runtime policy owns effective work'
    );
  if (isPlo4HoldoutSeed(options.seed))
    throw new Error(
      'Held-out PLO4 strength seeds run only through the P10.2 contract shard runner'
    );
  if (isOmahaVariantHoldoutSeed(options.seed))
    throw new Error(
      'Held-out Phase 11 strength seeds run only through the P11.2 contract shard runner'
    );
  if (isRemainingVariantHoldoutSeed(options.seed))
    throw new Error(
      'Held-out Phase 12 strength seeds run only through the P12.2 contract shard runner'
    );
  if (isJointHoldoutSeed(options.seed))
    throw new Error(
      'Held-out Phase 13 strength seeds run only through the P13.2 contract shard runner'
    );
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
    !['off', 'shadow', 'candidate'].includes(options.mode ?? 'candidate')
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

// ── P10.2 strength contract machinery ───────────────────────────────────────

/** The engine's own cash pricing for the published 1/2 game of the profile's
 * variant (PLO4 when the profile names none), built the way
 * ServerTableEngineBase builds a cash hand config. */
function publishedCashPricing(
  profile: Plo4LeagueProfile
): Pick<HandConfig, 'rakeConfig' | 'bbjConfig'> {
  if (profile.tournament || BB !== PLO4_STRENGTH_BB)
    throw new Error('Published PLO4 pricing is the cash 1/2 game only');
  const full = getFullRakeConfig(1, BB, profile.variant ?? 'plo4');
  return {
    rakeConfig: {
      percent: full.rakePercent,
      cap: full.rakeCap,
      noFlopNoDrop: true,
      playerCountCaps: getPlayerCountCaps(full.rakeCap, profile.tableSeats ?? profile.seats),
    },
    bbjConfig: {
      enabled: full.bbjEnabled,
      feeBB: full.bbjFeeBB,
      minPotBB: full.rules.minPotBB,
      minPlayersDealt: full.rules.minPlayersDealt,
    },
  };
}

/** Independent per-hand settlement and deduction checks (Phase 9 rules). The
 * controller's result is compared with OmahaReference's gross awards on the
 * same contributions and cards, and its rake/BBJ with the rake specification
 * the database implements, on the contested pot. The variant is the profile's
 * (PLO4 when it names none); PLO8 settles high and low halves. */
export function plo4IndependentHandChecks(
  profile: Plo4LeagueProfile,
  end: ReturnType<HandController['getState']>,
  receipt: Plo4HandReceipt,
  config: HandConfig
): Plo4HandChecks {
  const checks: Plo4HandChecks = {
    trace: end.actionHistory.map((a) => `${a.seat}:${a.action}:${a.amount ?? 0}:${a.stage}`),
    settlementMismatches: 0,
    deductionMismatches: 0,
    showdownChecked: false,
    foldWinChecked: false,
  };
  const start = profile.stackBB * BB;
  const cents = (n: number) => Math.round(n * 100);
  const variant = (profile.variant ?? 'plo4') as OmahaVariant;
  try {
    const players = end.players.map((p) => ({
      id: p.user_id,
      seat: p.seat,
      cards: p.cards,
      contributed: cents(p.totalInvested) / 100,
      folded: p.is_folded,
    }));
    const received = new Map(
      end.players.map((p) => [p.user_id, cents(p.stack - start + p.totalInvested)])
    );
    const { refunds } = contributionLayers(players, 0.01);
    const contributed = players.reduce((s, p) => s + cents(p.contributed), 0);
    const refunded = Object.values(refunds).reduce((s, v) => s + cents(v), 0);
    const pot = (contributed - refunded) / 100;
    const sawFlop = end.communityCards.length >= 3;
    const playersDealt = end.players.filter((p) => !p.is_sitting_out).length;
    if (profile.publishedRake) {
      const rake = effectiveRake({
        bb: config.bigBlind,
        sb: config.smallBlind,
        pot,
        playersDealt,
        sawFlop,
        seats: profile.tableSeats ?? profile.seats,
      }).rake;
      const bbj = effectiveBbjDrop({
        bb: config.bigBlind,
        sb: config.smallBlind,
        playersDealt,
        sawFlop,
        variant,
        pot,
        rake,
      });
      if (cents(rake) !== cents(receipt.rake) || cents(bbj) !== cents(receipt.bbj))
        checks.deductionMismatches++;
    }
    const deductions = cents(receipt.rake) + cents(receipt.bbj);
    const live = end.players.filter((p) => !p.is_folded);
    if (live.length === 1) {
      checks.foldWinChecked = true;
      for (const p of end.players) {
        const expected = p === live[0] ? contributed - deductions : 0;
        if (Math.abs(received.get(p.user_id)! - expected) > 1) checks.settlementMismatches++;
      }
    } else if (end.communityCards.length === 5) {
      checks.showdownChecked = true;
      const reference = settleOmahaReference({
        variant,
        players,
        boards: [end.communityCards],
        chipUnit: 0.01,
        dealerSeat: end.dealerSeat,
      });
      let shortfall = 0;
      for (const p of players) {
        const gross = cents(reference.totals[p.id] ?? 0) + cents(reference.refunds[p.id] ?? 0);
        const got = received.get(p.id)!;
        // One cent of tolerance for a different odd-chip seat order.
        if (got > gross + 1 || (gross === 0 && got !== 0)) checks.settlementMismatches++;
        shortfall += gross - got;
      }
      if (Math.abs(shortfall - deductions) > 1) checks.settlementMismatches++;
      if (reference.awards.some((a) => a.half === 'low')) checks.lowHalfChecked = true;
    } else checks.settlementMismatches++;
  } catch {
    checks.settlementMismatches++;
  }
  return checks;
}

/** Street of the first action at which two arms' traces differ. */
export function plo4DivergenceStreet(
  a: readonly string[],
  b: readonly string[]
): Plo4DivergenceStreet {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const stage = (a[i] ?? b[i]).split(':')[3];
    if (!(PLO4_DIVERGENCE_STREETS as readonly string[]).includes(stage) || stage === 'none')
      throw new Error(`Unknown divergence stage ${stage}`);
    return stage as Plo4DivergenceStreet;
  }
  return 'none';
}

/** A non-hero seat's decision under the human-calibrated population, read from
 * the same authoritative menu and public state the hero's request uses. */
function humanCalibratedSeatDecision(
  seat: SeatPlayer,
  state: ReturnType<HandController['getState']>,
  menu: NonNullable<ReturnType<HandController['getAuthoritativeActionState']>>,
  variant: string,
  profile: Plo4LeagueProfile,
  receipt: Plo4HandReceipt
): HorseDecision {
  const spot: HumanCalibratedSpot = {
    variant,
    stage: state.stage,
    cards: seat.cards,
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
    wholeChips: profile.tournament || profile.asset === 'diamonds',
  };
  const override = profile.humanCalibratedProfiles?.find(
    (p) => p.family === humanCalibratedFamily(variant)
  );
  const d = override ? humanCalibratedDecide(spot, override) : humanCalibratedDecide(spot);
  const nodes = (receipt.humanCalibrated ??= {});
  const tally = (nodes[d.node] ??= {});
  tally[d.action] = (tally[d.action] ?? 0) + 1;
  const bins = ((receipt.humanCalibratedStrength ??= {})[d.node] ??= Array<number>(
    HUMAN_CALIBRATED_STRENGTH_BINS
  ).fill(0));
  bins[
    Math.min(
      HUMAN_CALIBRATED_STRENGTH_BINS - 1,
      Math.floor(d.strength * HUMAN_CALIBRATED_STRENGTH_BINS)
    )
  ]++;
  return {
    action: d.action,
    ...(d.amount !== undefined ? { amount: d.amount } : {}),
    thinkTime: 0,
  };
}

/** A league profile whose non-hero seats play the human-calibrated population.
 * A new profile with its own id; the source profile is not changed. */
export function withHumanCalibratedOpponents(
  profile: Readonly<Plo4LeagueProfile>
): Readonly<Plo4LeagueProfile> {
  if (profile.opponentPopulation) throw new Error('Profile already names its opponent population');
  return Object.freeze({
    ...profile,
    id: `${profile.id}--${HUMAN_CALIBRATED_POPULATION_ID}`,
    opponentPopulation: HUMAN_CALIBRATED_POPULATION_ID,
  });
}

/** A contract profile as a league profile: published pricing, production styles. */
export function plo4StrengthLeagueProfile(profileId: string): Plo4LeagueProfile {
  const p = plo4StrengthProfile(profileId);
  if (!p) throw new Error('Unknown P10.2 strength profile');
  const full = getFullRakeConfig(1, BB, 'plo4');
  return {
    id: p.id,
    seats: p.seats,
    tableSeats: p.tableSeats,
    stackBB: p.stackBB,
    rakePercent: full.rakePercent,
    rakeCapBB: full.rakeCap / BB,
    anteBB: 0,
    straddle: false,
    tournament: false,
    opponentStyle: 'balanced',
    publishedRake: true,
    productionStyles: true,
  };
}

/**
 * One shard of the P10.2 matrix: a fixed range of pair indices of one
 * (profile, seed) cell, candidate arm then reference arm on each deal.
 * Contract mode plays exactly the contract's pairs on a held-out seed;
 * development mode (tests, timing) may play fewer pairs and never touches a
 * held-out seed. Neither mode can promote: the verdict is
 * summarizePlo4Strength over every shard.
 */
export async function runPlo4StrengthShard(
  request: {
    profileId: string;
    seed: number;
    shard: number;
    mode: 'contract' | 'development';
    pairs?: number;
  },
  shouldContinue = () => true
): Promise<Plo4StrengthShardResult> {
  const c = PLO4_STRENGTH_CONTRACT;
  const holdout = isPlo4HoldoutSeed(request.seed);
  if (request.mode !== 'contract' && request.mode !== 'development')
    throw new Error('Unknown P10.2 shard mode');
  if (isOmahaVariantHoldoutSeed(request.seed))
    throw new Error('A P10.2 shard never runs a held-out Phase 11 seed');
  if (isRemainingVariantHoldoutSeed(request.seed))
    throw new Error('A P10.2 shard never runs a held-out Phase 12 seed');
  if (isJointHoldoutSeed(request.seed))
    throw new Error('A P10.2 shard never runs a held-out Phase 13 seed');
  if (request.mode === 'contract' && !holdout)
    throw new Error('A contract shard runs only a held-out seed');
  if (request.mode === 'development' && holdout)
    throw new Error('A development shard never runs a held-out seed');
  if (!Number.isInteger(request.seed) || request.seed < 1 || request.seed > 0xffffffff)
    throw new Error('Invalid P10.2 shard seed');
  const contractProfile = plo4StrengthProfile(request.profileId);
  if (
    !contractProfile ||
    !Number.isInteger(request.shard) ||
    request.shard < 0 ||
    request.shard >= contractProfile.shards
  )
    throw new Error('P10.2 shard outside the matrix');
  const requested = request.pairs ?? c.matrix.pairsPerShard;
  if (request.mode === 'contract' && requested !== c.matrix.pairsPerShard)
    throw new Error('A contract shard plays exactly the contract pairs per shard');
  if (!Number.isInteger(requested) || requested < 1 || requested > c.matrix.pairsPerShard)
    throw new Error('Invalid P10.2 shard pair count');
  const profile = plo4StrengthLeagueProfile(request.profileId);
  assertFixedBudget();
  const started = performance.now();
  const firstPair = request.shard * c.matrix.pairsPerShard;
  const strata = new Map<string, Plo4PowerAccumulator>();
  const offsetCounts: number[] = Array(profile.seats).fill(0);
  const digest = createHash('sha256');
  const result: Plo4StrengthShardResult = {
    schema: 'horse-phase10-strength-shard-v1',
    contractVersion: c.version,
    contractDigest: plo4StrengthContractDigest(),
    packVersion: PLO4_POLICY_PACK.version,
    evidenceMode: request.mode,
    profileId: profile.id,
    seed: request.seed,
    shard: request.shard,
    firstPair,
    requestedPairs: requested,
    pairs: 0,
    complete: false,
    positionCoverageComplete: false,
    offsetCounts,
    strata: {},
    pairDigest: '',
    candidateNetCents: 0,
    referenceNetCents: 0,
    changedPairs: 0,
    decisions: 0,
    eligible: 0,
    changed: 0,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    truncatedHands: 0,
    settlementMismatches: 0,
    deductionMismatches: 0,
    pairedReplayMismatches: 0,
    showdownsChecked: 0,
    foldWinsChecked: 0,
    totalRake: 0,
    totalBbj: 0,
    nodeCounts: {},
    reasons: {},
    equityWork: {},
    fixedWork: { governor: 'off', scale: 1, policyClock: 'fixed_work_no_wall_clock_branch' },
    durationMs: 0,
    promotionEligible: false,
  };
  const merge = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  };
  const absorb = (h: Plo4HandReceipt) => {
    result.decisions += h.decisions;
    result.eligible += h.eligible;
    result.changed += h.changed;
    result.illegalActions += h.illegalActions;
    result.conservationErrors += h.conservationErrors;
    result.cardErrors += h.cardErrors;
    result.truncatedHands += h.truncated;
    result.totalRake += h.rake;
    result.totalBbj += h.bbj;
    merge(result.nodeCounts, h.nodeCounts);
    merge(result.reasons, h.reasons);
    merge(result.equityWork, h.equityWork);
    if (h.checks) {
      result.settlementMismatches += h.checks.settlementMismatches;
      result.deductionMismatches += h.checks.deductionMismatches;
      result.showdownsChecked += Number(h.checks.showdownChecked);
      result.foldWinsChecked += Number(h.checks.foldWinChecked);
    }
  };
  for (let k = 0; k < requested; k++) {
    if (!shouldContinue()) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const i = firstPair + k;
    const dealSeed = (request.seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
    const { heroSeat, button, relativePosition } = plo4LeagueSeating(i, profile.seats);
    const candidate = await playPlo4PolicyHand(
      profile,
      dealSeed,
      button,
      heroSeat,
      'candidate',
      shouldContinue,
      true
    );
    absorb(candidate);
    if (!candidate.complete || !candidate.checks) break;
    const reference = await playPlo4PolicyHand(
      profile,
      dealSeed,
      button,
      heroSeat,
      'off',
      shouldContinue,
      true
    );
    absorb(reference);
    if (!reference.complete || !reference.checks) break;
    const candidateCents = Math.round(candidate.net[heroSeat - 1] * 100);
    const referenceCents = Math.round(reference.net[heroSeat - 1] * 100);
    const difference = candidateCents - referenceCents;
    const street = plo4DivergenceStreet(candidate.checks.trace, reference.checks.trace);
    if (street === 'none' && difference !== 0) result.pairedReplayMismatches++;
    const key = `${relativePosition}|${street}`;
    const acc = strata.get(key) ?? new Plo4PowerAccumulator();
    acc.add(difference);
    strata.set(key, acc);
    offsetCounts[relativePosition]++;
    result.candidateNetCents += candidateCents;
    result.referenceNetCents += referenceCents;
    result.changedPairs += Number(street !== 'none');
    digest.update(`${i}:${difference}:${street};`);
    result.pairs++;
  }
  result.strata = Object.fromEntries(
    [...strata.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.toJSON()])
  );
  result.pairDigest = digest.digest('hex');
  result.complete = result.pairs === requested;
  result.positionCoverageComplete =
    result.complete && offsetCounts.every((n) => n > 0 && n === offsetCounts[0]);
  result.totalRake = Math.round(result.totalRake * 100) / 100;
  result.totalBbj = Math.round(result.totalBbj * 100) / 100;
  result.durationMs = Math.round(performance.now() - started);
  return result;
}
