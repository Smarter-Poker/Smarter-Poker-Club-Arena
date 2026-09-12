import type { Card, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import type { TournamentUtilityShowdownSample } from '../HorseTournamentUtility.js';
import {
  saveFastRandom,
  scoreHoldem,
  scoreOmahaHi,
  scoreOmahaHiPartial,
  scoreOmahaLow,
} from '../HorseEval.js';
import { horseVariantRulesFor, isKnownVariant } from '../VariantRules.js';
import { plo4HandShape } from '../plo4/Plo4PolicyPack.js';
import { isOmahaPolicyVariant, omahaVariantHandShape } from '../omaha/OmahaVariantPolicyPack.js';
import { remainingVariantHandShape } from '../remainingVariants/RemainingVariantPolicyPack.js';
import { choosePineappleFlopPair } from '../remainingVariants/RemainingVariantSampler.js';
import { buildJointCardLayout, type JointCardLayoutInput } from './JointCardLayout.js';
import { validateDealtSeatCensus } from './DealtSeatCensus.js';

export const JOINT_RANGE_PACK = Object.freeze({
  version: 'joint-public-range-round1-v1',
  source: 'explicit_public_line_heuristic',
  confidence: 'heuristic_uncalibrated',
  defaultSamples: 32,
  maxSamples: 128,
  rejectionAttempts: 3,
  uniformEscape: true,
});

export interface JointOpponentRange {
  userId: string;
  seat: number;
  folded: boolean;
  live: boolean;
  allIn: boolean;
  raises: number;
  calls: number;
  checks: number;
  observedActions: number;
  prior: 'uniform_bomb_deal' | 'structural_variant_prior';
  confidence: 'heuristic_uncalibrated';
  /** Does not convert a structural score into calibrated equity. */
  exponent: number;
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const stages = ['preflop', 'flop', 'turn', 'river'];
const key = (card: Card) => card.rank + ':' + card.suit;

function structuralQuality(variant: string, cards: Card[]): number {
  if (variant === 'plo4') return plo4HandShape(cards).quality;
  if (isOmahaPolicyVariant(variant)) return omahaVariantHandShape(variant, cards).quality;
  return remainingVariantHandShape(
    variant === 'nlh' ? 'flh' : (variant as 'short_deck' | 'pineapple' | 'flh' | 'flo8'),
    cards,
    variant === 'pineapple' && cards.length === 2
  ).quality;
}

/** A bounded structural response read of the cards visible AT THE DECISION.
 * It never receives future runout cards or compares opponents' hidden hands. */
export function jointDecisionStrength(variant: string, cards: Card[], board: Card[]): number {
  const shape = structuralQuality(variant, cards);
  if (board.length < 3) return shape;
  const rules = horseVariantRulesFor(variant);
  const score =
    rules.holeCardsUse === 'exactly_two'
      ? scoreOmahaHiPartial(cards, board)
      : scoreHoldem([...cards, ...board], cards.length + board.length, rules.deckSize === 36);
  const category = Math.floor(score / 0x100000);
  // Qualification on a partial board needs exactly two distinct low hole
  // ranks and three other low board ranks. The river-only scorer assumes
  // five board cards and must never receive a flop or turn.
  const lowRanks = (values: Card[]) => [
    ...new Set(
      values
        .map((c) => (c.rank === 'A' ? 1 : '23456789TJQKA'.indexOf(c.rank) + 2))
        .filter((v) => v <= 8)
    ),
  ];
  const holeLows = rules.splitLow8OrBetter ? lowRanks(cards) : [];
  const boardLows = rules.splitLow8OrBetter ? lowRanks(board) : [];
  const lowQualifies = holeLows.some((a, i) =>
    holeLows.slice(i + 1).some((b) => boardLows.filter((v) => v !== a && v !== b).length >= 3)
  );
  return clamp(shape * 0.25 + (category / 8) * 0.6 + Number(lowQualifies) * 0.15);
}

export function buildJointOpponentRanges(
  hero: SeatPlayer,
  state: HorseGameStateV2
): JointOpponentRange[] {
  const ids = validateDealtSeatCensus(state.players, hero.seat, state.dealtSeatIds);
  const currentStreet = stages.indexOf(state.stage);
  return state.players
    .filter((p) => p.user_id !== hero.user_id && ids.includes(p.seat))
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      const line = (state.actionHistory ?? []).filter(
        (a) =>
          a.userId === p.user_id &&
          stages.indexOf(a.stage) >= 0 &&
          stages.indexOf(a.stage) <= currentStreet &&
          (!state.bombPot || a.stage !== 'preflop')
      );
      const raises = line.filter(
        (a) =>
          ['bet', 'raise'].includes(a.action) ||
          (a.action === 'all_in' && a.isFullRaise !== undefined)
      ).length;
      const calls = line.filter(
        (a) => a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined)
      ).length;
      const checks = line.filter((a) => a.action === 'check').length;
      return {
        userId: p.user_id,
        seat: p.seat,
        folded: p.is_folded,
        live: !p.is_folded && (!p.is_sitting_out || p.is_all_in),
        allIn: p.is_all_in,
        raises,
        calls,
        checks,
        observedActions: raises + calls + checks,
        prior: state.bombPot ? 'uniform_bomb_deal' : 'structural_variant_prior',
        confidence: 'heuristic_uncalibrated',
        exponent: Math.min(4, (state.bombPot ? 0 : 1) + raises * 0.7 + calls * 0.15),
      };
    });
}

export interface JointRangeSamples {
  version: string;
  ranges: JointOpponentRange[];
  opponentIds: string[];
  samples: TournamentUtilityShowdownSample[];
  requestedSamples: number;
  sampleBudgetExhausted: boolean;
  boardCount: number;
  physicalCardsPerSample: number;
  unknownDealtCardsPerSample: number;
  uniformEscapes: number;
  analysisMs: number;
}

/** One physical shuffled deal supplies EVERY board, score and opponent in a
 * sample. The local stream cannot advance the baseline strategy's RNG. Deck
 * occupancy includes folded/disconnected deals and private known hero discards.
 * Results carry scored outcomes only, never sampled opponent card faces. */
export function sampleJointRanges(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  options: {
    samples?: number;
    withinBudget: () => boolean;
    /** Explicit frozen local seed is for offline certification. */
    seed?: number;
    /** Offline certification tap over fresh synthetic deals; never serialized
     * into worker options, receipts or production telemetry. Copies prevent an
     * observer from changing a scored sample. */
    inspectPhysicalSample?: (sample: {
      heroCards: Card[];
      heroRetainedCards: Card[];
      knownDeadCards: Card[];
      opponentDeals: { userId: string; dealt: Card[]; retained: Card[] }[];
      boards: Card[][];
    }) => void;
  }
): JointRangeSamples | null {
  const started = performance.now();
  if (
    !isKnownVariant(state.gameVariant) ||
    !stages.includes(state.stage) ||
    state.players.some((p) => p.cards.length > 0 || p.knownDeadCards?.length)
  )
    return null;
  const requested = options.samples ?? JOINT_RANGE_PACK.defaultSamples;
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    requested > JOINT_RANGE_PACK.maxSamples ||
    (options.seed !== undefined &&
      (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff))
  )
    return null;
  let layout: ReturnType<typeof buildJointCardLayout>;
  let ranges: JointOpponentRange[];
  try {
    const ids = validateDealtSeatCensus(state.players, hero.seat, state.dealtSeatIds);
    const count = state.boardCount ?? 1;
    if (
      ![1, 2, 3].includes(count) ||
      (count < 2 && state.communityCards2?.length) ||
      (count < 3 && state.communityCards3?.length)
    )
      return null;
    layout = buildJointCardLayout({
      variant: state.gameVariant,
      stage: state.stage as JointCardLayoutInput['stage'],
      heroCards: hero.cards,
      knownDeadCards: hero.knownDeadCards,
      dealtSeats: ids.length,
      boards: [
        state.communityCards,
        ...(count >= 2 ? [state.communityCards2!] : []),
        ...(count === 3 ? [state.communityCards3!] : []),
      ],
      layout: 'independent',
    });
    ranges = buildJointOpponentRanges(hero, state);
  } catch {
    return null;
  }
  const active = ranges.filter((p) => p.live);
  if (!active.length) return null;
  const rules = horseVariantRulesFor(state.gameVariant);
  let stream = ((options.seed ?? saveFastRandom()) ^ 0x51a7e13) >>> 0;
  for (const card of layout.physicalKnownCards)
    for (const char of key(card)) stream = Math.imul(stream ^ char.charCodeAt(0), 16777619) >>> 0;
  stream ||= 1;
  const random = () => {
    stream ^= stream << 13;
    stream ^= stream >>> 17;
    stream ^= stream << 5;
    return (stream >>> 0) / 0x100000000;
  };
  const samples: TournamentUtilityShowdownSample[] = [];
  let uniformEscapes = 0;
  sampleLoop: for (let index = 0; index < requested; index++) {
    if (!options.withinBudget()) break;
    let deck = layout.availableCards.slice();
    const hands = new Map<string, Card[]>();
    const originalHands = new Map<string, Card[]>();
    const strengths = new Map<string, number[]>();
    // Randomize conditional seat order to avoid privileging the lowest seat.
    const order = ranges.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const range of order) {
      let selected: Card[] | undefined;
      for (let attempt = 0; attempt < JOINT_RANGE_PACK.rejectionAttempts; attempt++) {
        if (!options.withinBudget()) break sampleLoop;
        const trial = deck.slice();
        const cards = Array.from(
          { length: rules.holeCardsDealt },
          () => trial.splice(Math.floor(random() * trial.length), 1)[0]
        );
        // Actual Pineapple discards happen on the first flop. This declared
        // prior sees that flop only, never the turn/river or another runout.
        const retained =
          state.gameVariant === 'pineapple' && state.communityCards.length >= 3
            ? choosePineappleFlopPair(cards, state.communityCards.slice(0, 3))
            : cards;
        const reads = layout.boards.map((b) =>
          jointDecisionStrength(state.gameVariant, retained, b)
        );
        const mean = reads.reduce((a, b) => a + b, 0) / reads.length;
        const signal = Math.min(1, mean * 0.7 + Math.max(...reads) * 0.3);
        const weight = Math.pow(0.25 + signal * 0.75, range.exponent);
        if (
          range.exponent === 0 ||
          random() <= weight ||
          attempt === JOINT_RANGE_PACK.rejectionAttempts - 1
        ) {
          if (range.exponent > 0 && attempt === JOINT_RANGE_PACK.rejectionAttempts - 1)
            uniformEscapes++;
          deck = trial;
          selected = retained;
          originalHands.set(range.userId, cards);
          strengths.set(range.userId, reads);
          break;
        }
      }
      if (!selected) return null;
      hands.set(range.userId, selected);
    }
    const boards = layout.boards.map((b) => b.slice());
    // Deal all flops before any turns/rivers. On preflop Pineapple the one
    // retained pair is chosen here and reused on every eventual board.
    for (const board of boards)
      while (board.length < 3) board.push(deck.splice(Math.floor(random() * deck.length), 1)[0]);
    let heroCards = hero.cards;
    if (state.gameVariant === 'pineapple' && state.stage === 'preflop') {
      heroCards = choosePineappleFlopPair(hero.cards, boards[0].slice(0, 3));
      for (const [id, cards] of hands)
        hands.set(id, choosePineappleFlopPair(cards, boards[0].slice(0, 3)));
    }
    for (let length = 4; length <= 5; length++)
      for (const board of boards)
        if (board.length < length)
          board.push(deck.splice(Math.floor(random() * deck.length), 1)[0]);
    if (!options.withinBudget()) break;
    if (options.inspectPhysicalSample) {
      const copy = (cards: readonly Card[]) => cards.map((c) => ({ ...c }));
      options.inspectPhysicalSample({
        heroCards: copy(hero.cards),
        heroRetainedCards: copy(heroCards),
        knownDeadCards: copy(hero.knownDeadCards ?? []),
        opponentDeals: ranges.map((p) => ({
          userId: p.userId,
          dealt: copy(originalHands.get(p.userId)!),
          retained: copy(hands.get(p.userId)!),
        })),
        boards: boards.map(copy),
      });
    }
    samples.push({
      boards: boards.map((board, b) => {
        const high = (cards: Card[]) =>
          rules.holeCardsUse === 'exactly_two'
            ? scoreOmahaHi(cards, board)
            : scoreHoldem([...cards, ...board], cards.length + board.length, rules.deckSize === 36);
        const low = (cards: Card[]) => {
          const score = rules.splitLow8OrBetter ? scoreOmahaLow(cards, board) : Infinity;
          return Number.isFinite(score) ? score : null;
        };
        return {
          heroHigh: high(heroCards),
          heroLow: low(heroCards),
          opponentHigh: active.map((p) => high(hands.get(p.userId)!)),
          opponentLow: active.map((p) => low(hands.get(p.userId)!)),
          opponentDecisionStrength: active.map((p) => strengths.get(p.userId)![b]),
        };
      }),
    });
  }
  if (!samples.length) return null;
  return {
    version: JOINT_RANGE_PACK.version,
    ranges,
    opponentIds: active.map((p) => p.userId),
    samples,
    requestedSamples: requested,
    sampleBudgetExhausted: samples.length < requested,
    boardCount: layout.boardCount,
    unknownDealtCardsPerSample: layout.unknownHoleCards,
    physicalCardsPerSample:
      layout.physicalKnownCards.length + layout.unknownHoleCards + layout.unknownRunoutCards,
    uniformEscapes,
    analysisMs: performance.now() - started,
  };
}
