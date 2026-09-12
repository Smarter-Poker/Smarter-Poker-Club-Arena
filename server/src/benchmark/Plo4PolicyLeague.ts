import type { Card, HandConfig, HandEvent, HorseStyle, SeatPlayer } from '../types.js';
import { HandController } from '../engine/HandController.js';
import { HorseLogic, type HorseGameStateV2 } from '../engine/HorseLogic.js';
import { HorseMind } from '../engine/HorseMind.js';
import { restoreFastRandom, saveFastRandom, seedFastRandom } from '../engine/HorseEval.js';
import { calculateContestablePot } from '../engine/PokerEngine.js';
import { horseVariantRulesFor } from '../engine/VariantRules.js';
import { PLO4_POLICY_PACK } from '../engine/plo4/Plo4PolicyPack.js';
import { referenceDeck, uniqueCards } from './OmahaReference.js';
import type { Plo4PolicyMode } from './Plo4PolicyProgram.js';
import { equityGovernor } from '../engine/EquityLoadGovernor.js';
import { equitySampleSizeOfLastCall, variantInfo } from '../engine/HorseEval.js';
import { gtoChartCount } from '../engine/GtoCharts.js';
import { gtoPostflopCount } from '../engine/GtoPostflop.js';
import { gtoPostflopV31Count, gtoPostflopV31Dataset } from '../engine/GtoPostflopV31.js';
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

export interface Plo4LeagueProfile {
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
function deckFor(seed: number): Card[] {
  const deck = referenceDeck();
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
  const receipt: Plo4HandReceipt = {
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
    tableId: 'phase10-offline-league',
    handNumber: 1,
    gameVariant: 'plo4',
    smallBlind: 1,
    bigBlind: BB,
    ante: profile.anteBB * BB,
    isTournament: profile.tournament,
    rakeConfig: { percent: profile.rakePercent, cap: profile.rakeCapBB * BB, noFlopNoDrop: true },
    ...(profile.straddle
      ? { straddles: [{ seat: ((button + 2) % profile.seats) + 1, amount: BB * 2 }] }
      : {}),
  };
  const controller = new HandController(config, players, button);
  // Only this offline controller's instance receives the fixed deck. No global
  // shuffle, live controller, persistent service or opponent memory is touched.
  const deck = deckFor(seed);
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
    for (let step = 0; step < PLO4_POLICY_PACK.maxActionsPerHand && !finished; step++) {
      if (!shouldContinue()) return receipt;
      if (runout) {
        runout = false;
        controller.continueRunout();
        continue;
      }
      const state = controller.getState();
      const hero = state.players.find((p) => p.seat === state.currentPlayerSeat);
      if (!hero) {
        receipt.truncated++;
        return receipt;
      }
      const menu = controller.getAuthoritativeActionState(hero.user_id);
      if (!menu?.canAct) {
        receipt.truncated++;
        return receipt;
      }
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
        gameMode: profile.tournament ? 'tournament' : 'cash',
        format: profile.tournament ? 'sng' : 'cash',
        gameVariant: 'plo4',
        bigBlind: BB,
        ante: config.ante,
        straddleActive: profile.straddle,
        boardCount: 1,
        legalActions: menu.legalActions,
        toCall: menu.toCall,
        minRaiseTo: menu.minRaiseTo,
        maxRaiseTo: menu.maxRaiseTo,
        bettingStructure: menu.structure,
        pots: controller.computeLivePots(),
        contestablePot: calculateContestablePot(state.players, hero.user_id, menu.toCall),
        variantRules: horseVariantRulesFor('plo4'),
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
            phase10Plo4: hero.seat === heroSeat ? mode : 'off',
            phase10EvidenceMode: true,
          }
        )
      );
      const selected = baseline;
      if (gs.stage !== 'preflop') {
        const work = String(equitySampleSizeOfLastCall());
        receipt.equityWork[work] = (receipt.equityWork[work] ?? 0) + 1;
      }
      if (hero.seat === heroSeat && baseline.plo4Policy) {
        const policy = baseline.plo4Policy;
        receipt.eligible += Number(policy.eligible);
        receipt.changed += Number(policy.applied);
        const node = `${gs.gameMode}/${gs.stage}/${policy.role ?? 'outside_domain'}`;
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
      uniqueCards([...end.players.flatMap((p) => p.cards), ...end.communityCards]);
    } catch {
      receipt.cardErrors++;
    }
    receipt.net = end.players.map((p) => p.stack - profile.stackBB * BB);
    if (Math.abs(receipt.net.reduce((sum, n) => sum + n, 0) + receipt.rake + receipt.bbj) > 0.011)
      receipt.conservationErrors++;
    receipt.complete = !receipt.cardErrors && !receipt.conservationErrors;
    return receipt;
  } finally {
    restoreFastRandom(rng);
  }
}

export async function runPlo4PolicyLeague(
  options: {
    profileId: string;
    pairs: number;
    seed: number;
    mode?: Plo4PolicyMode;
    samples?: number;
  },
  shouldContinue = () => true
) {
  const profile = PLO4_LEAGUE_PROFILES.find((p) => p.id === options.profileId);
  if (
    !profile ||
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
    version: PLO4_POLICY_PACK.version,
    fixedWork: {
      governor: 'off',
      scale: 1,
      requestedBaselineIterations: variantInfo('plo4').iterations,
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
    populationRangeModel: 'public_line_conditioned_HorseMind_population_prior_uncalibrated',
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
