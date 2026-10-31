/**
 * A deterministic corpus of real tournament decisions for the V53 Omaha
 * tournament pressure layer (HorseOmahaTournamentPressure.ts).
 *
 * Every spot is a real HandController hand: PLO4, PLO5, PLO6 and NLH, six
 * seats, tournament stacks from 4 to 60 big blinds, and five field shapes
 * (early field, stone bubble, final table, Sit & Go bubble, in the money).
 * Every seat that is asked to act is decided by HorseLogic.decide with the
 * caller's options, and the hand plays out, so the corpus covers preflop
 * entry, commitment, re-raise and postflop decisions alike.
 *
 * Two uses:
 *  - the default-off pin: the digest of every decision with the V53 flag
 *    absent must equal the digest captured on origin/main before the layer
 *    was recovered (e9725f3), so "flag off" is byte-identical to the protected baseline brain;
 *  - the not-inert pin: with the flag on, Omaha decisions change and NLH
 *    decisions do not.
 *
 * Uses only APIs that predate the layer, so the same driver produced the
 * pinned digest on the base commit.
 */
import { createHash } from 'node:crypto';
import { HandController } from './HandController.js';
import { HorseLogic, type HorseGameStateV2, type HorseDecideOpts } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { calculateContestablePot, RANKS, SUITS } from './PokerEngine.js';
import { holeCardCount, horseVariantRulesFor } from './VariantRules.js';
import { buildTournamentMState } from './HorseTournamentPreflop.js';
import type { Card, HandEvent, SeatPlayer } from '../types.js';

export const CORPUS_VARIANTS = ['plo4', 'plo5', 'plo6', 'nlh'] as const;
export type CorpusVariant = (typeof CORPUS_VARIANTS)[number];

interface FieldShape {
  name: string;
  playersLeft: number;
  payoutPct: number[];
}

/** Five tournament field shapes; the payout curve is for the remaining places. */
export const CORPUS_FIELDS: readonly FieldShape[] = [
  { name: 'early', playersLeft: 16, payoutPct: [40, 25, 15, 12, 8] },
  { name: 'stone_bubble', playersLeft: 9, payoutPct: [40, 25, 18, 10, 7, 0, 0, 0] },
  { name: 'final_table', playersLeft: 6, payoutPct: [40, 25, 18, 10, 7] },
  { name: 'sng_bubble', playersLeft: 3, payoutPct: [65, 35] },
  { name: 'in_money', playersLeft: 5, payoutPct: [45, 27, 16, 12] },
];

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function shuffled(seed: number): Card[] {
  const cards = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
  const next = random(seed);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export interface CorpusDecision {
  variant: CorpusVariant;
  field: string;
  hand: number;
  stage: string;
  seat: number;
  action: string;
  amount: number | null;
}

/**
 * Play `hands` hands of `variant` at a six-seat tournament table and return
 * every decision HorseLogic made, in order.
 */
export function playCorpus(
  variant: CorpusVariant,
  hands: number,
  seed: number,
  opts: HorseDecideOpts
): CorpusDecision[] {
  const out: CorpusDecision[] = [];
  const hc = holeCardCount(variant);
  for (let hand = 0; hand < hands; hand++) {
    const handSeed = (seed ^ Math.imul(hand + 1, 2654435761)) >>> 0 || 1;
    const draw = random(handSeed ^ 0x51ed);
    const field = CORPUS_FIELDS[hand % CORPUS_FIELDS.length];
    const seats = Math.min(6, Math.max(2, field.playersLeft));
    const bigBlind = 200;
    const ante = 25;
    const players: SeatPlayer[] = Array.from({ length: seats }, (_, i) => ({
      seat: i + 1,
      user_id: `corpus-${i + 1}`,
      username: `Horse ${i + 1}`,
      // 4bb to 60bb, whole chips.
      stack: Math.round((4 + draw() * 56) * bigBlind),
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    }));
    const remote = Array.from({ length: Math.max(0, field.playersLeft - seats) }, () =>
      Math.round((4 + draw() * 56) * bigBlind)
    );
    const dealerSeat = 1 + (hand % seats);
    const config = {
      tableId: 'v53-corpus',
      handNumber: hand + 1,
      gameVariant: variant,
      isTournament: true,
      smallBlind: bigBlind / 2,
      bigBlind,
      ante,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    };
    const controller = new HandController(config, players, dealerSeat);
    const deck = shuffled(handSeed);
    const holes = deck.slice(0, seats * hc);
    const rest = deck.slice(seats * hc);
    const ordered = holes.concat(rest);
    const instance = controller.getState().deck as unknown as {
      deal: (n?: number) => Card[];
      dealOne: () => Card;
      remaining: () => number;
      getRemainingCards: () => Card[];
    };
    instance.deal = (n = 1) => {
      if (ordered.length < n) throw new Error('corpus deck exhausted');
      return ordered.splice(0, n);
    };
    instance.dealOne = () => instance.deal(1)[0];
    instance.remaining = () => ordered.length;
    instance.getRemainingCards = () => ordered.slice();
    let complete = false;
    let runout = false;
    controller.onEvent((event: HandEvent) => {
      if (event.type === 'HAND_COMPLETE') complete = true;
      if (event.type === 'ALL_IN_RUNOUT') runout = true;
    });
    controller.start();
    for (let step = 0; step < 200 && !complete; step++) {
      if (runout) {
        runout = false;
        controller.continueRunout();
        continue;
      }
      const state = controller.getState();
      const hero = state.players.find((p) => p.seat === state.currentPlayerSeat);
      if (!hero) break;
      const menu = controller.getAuthoritativeActionState(hero.user_id);
      if (!menu?.canAct) break;
      const local = state.players.map((p) => p.stack + p.totalInvested);
      const stacks = [...local, ...remote].sort((a, b) => b - a);
      const tournament: NonNullable<HorseGameStateV2['tournament']> = {
        schemaVersion: 1,
        contextStatus: 'complete',
        contextIssues: [],
        sourceAgeMs: 0,
        tournamentId: 'v53-corpus',
        playersLeft: field.playersLeft,
        entrants: Math.max(field.playersLeft, 16),
        spotsPaid: field.payoutPct.filter((p) => p > 0).length,
        inMoney: field.playersLeft <= field.payoutPct.filter((p) => p > 0).length,
        payoutPct: field.payoutPct.slice(0, field.playersLeft),
        stacks,
        stackByUser: Object.fromEntries(
          state.players.map((p) => [p.user_id, p.stack + p.totalInvested])
        ),
        currentSmallBlind: bigBlind / 2,
        currentBigBlind: bigBlind,
        currentAnte: ante,
        anteType: 'per_player',
        playersAtTable: state.players.length,
        seatsPerTable: 6,
        nextSmallBlind: bigBlind,
        nextBigBlind: bigBlind * 2,
        nextAnte: ante * 2,
        nextBlindInMin: 6,
        currentLevel: 8,
        levelDurationMin: 10,
        levelElapsedMin: 4,
        prizePoolCents: 100_000,
        bountyPoolCents: 0,
        satellite: false,
        satelliteSeats: 0,
        isPko: false,
        isBounty: false,
        isMysteryBounty: false,
        mysteryBountyStage: 'none',
        mysteryMeanCents: 0,
        meanBountyCents: 0,
        bountyByUser: {},
        bountyFactor: 0,
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
        anteType: 'per_player',
        playersAtTable: state.players.length,
        nextSmallBlind: bigBlind,
        nextBigBlind: bigBlind * 2,
        nextAnte: ante * 2,
        minutesToNextLevel: 6,
        opponentStacks: state.players
          .filter((p) => p.user_id !== hero.user_id)
          .map((p) => ({ userId: p.user_id, stackChips: p.stack + p.totalInvested })),
      });
      const gs: HorseGameStateV2 = {
        players: state.players.map((p) => (p.user_id === hero.user_id ? p : { ...p, cards: [] })),
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
        format: field.name === 'sng_bubble' ? 'sng' : 'mtt',
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
      seedFastRandom((handSeed ^ Math.imul(step + 1, 1009) ^ hero.seat) >>> 0);
      const decision = HorseLogic.decide(hero, gs, 'balanced', {}, opts);
      out.push({
        variant,
        field: field.name,
        hand,
        stage: state.stage,
        seat: hero.seat,
        action: decision.action,
        amount: decision.amount ?? null,
      });
      if (
        !menu.legalActions.includes(decision.action) ||
        !controller.performAction(hero.seat, decision.action, decision.amount)
      ) {
        break;
      }
    }
    if (!complete) throw new Error(`Corpus hand did not complete: ${variant}/${hand}`);
  }
  return out;
}

/** One stable digest of a decision list. */
export function corpusDigest(decisions: readonly CorpusDecision[]): string {
  const hash = createHash('sha256');
  for (const d of decisions) {
    hash.update(
      `${d.variant}|${d.field}|${d.hand}|${d.stage}|${d.seat}|${d.action}|${d.amount ?? ''}\n`
    );
  }
  return hash.digest('hex');
}

/** The pinned corpus: hands per variant and the seed. */
export const CORPUS_HANDS = 20;
export const CORPUS_SEED = 5_301_024;

/** The base options every corpus decision runs with (offline, no memory). */
export const CORPUS_BASE_OPTS: HorseDecideOpts = {
  mind: false,
  telemetry: false,
  decisionTimeMs: 0,
  // V61 (2026-10-29) shades hold'em one-pair river calls by default; the
  // pre-candidate digests were captured before it, so the corpus keeps the
  // explicit off arm (HorseRiverOnePairShade.test.ts pins the real policy).
  v61RiverOnePairShade: false,
  // V69 (2026-10-31) re-prices hold'em turn calls (one-pair implied odds,
  // the V65 hole-card draw read) independently of any read, and it changed
  // the NLH digest; the corpus keeps the explicit off arm
  // (HorseTurnCallGaps.test.ts pins the real policy).
  v69TurnCallGaps: false,
  // V70 (2026-10-31) re-orders hold'em raise-first-in by seat (GTO reference
  // charts) independently of any read; the corpus keeps the explicit off arm
  // (HorseGtoOpeningRanges.test.ts pins the real policy).
  v70GtoOpeningRanges: false,
};
