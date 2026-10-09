import type { Card, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { RANKS, SUITS } from '../PokerEngine.js';
import {
  saveFastRandom,
  scoreHoldem,
  scoreOmahaHi,
  scoreOmahaLow,
  type HorseEquityOutcomeSample,
} from '../HorseEval.js';
import { horsePolicyDealtPlayers } from '../multiway/DealtSeatCensus.js';
import {
  variantEquityFromShowdowns,
  type OmahaVariantEquityEvidence,
} from '../omaha/OmahaVariantEquity.js';
import {
  REMAINING_VARIANT_DOMAIN,
  REMAINING_VARIANT_PACKS,
  remainingVariantHandShape,
  type RemainingPolicyVariant,
} from './RemainingVariantPolicyPack.js';

/**
 * P12.3: the samples one live draw requests at equity-governor scale `scale`.
 * At scale 1 (the governor off, as in the P12.2 matrix) it is the pack's full
 * count, `REMAINING_VARIANT_DOMAIN.defaultSamples`; under load it falls
 * proportionally, never below four. The P12.3 completion record counts a
 * consumed sample that requested fewer than the full count as
 * governor-reduced, never as completed.
 */
export function remainingVariantRequestedSamples(scale: number): number {
  return Math.max(
    4,
    Math.floor(REMAINING_VARIANT_DOMAIN.defaultSamples * Math.min(1, Math.max(0, scale)))
  );
}

/** P12.1: where the opponent holdings behind a live remaining-variant sample
 * came from. Each dealt opponent is drawn from one physical deck (36 cards for
 * Short Deck) under a sequential prior conditioned only on that opponent's
 * public raise and call counts, with a declared uniform escape on the third
 * attempt. For Crazy Pineapple every opponent's retained pair is chosen by the
 * declared flop-only structural prior (`choosePineappleFlopPair`), never by an
 * actual discard, and the hero's own accepted discard is excluded from the
 * deck: only its count is recorded here, never a card value. Nothing here is
 * calibrated or solver input. */
export interface RemainingVariantRangeProvenance {
  readonly version: 'remaining-variant-range-provenance-v1';
  readonly source: 'variant_public_line_sequential_prior';
  readonly calibration: 'uncalibrated';
  readonly solverInput: false;
  readonly reads: 'public_action_line_only';
  readonly prior: Readonly<{
    attemptsPerSeat: 3;
    finalAttempt: 'uniform_escape';
    /** Dealt-opponent draws inside completed samples. */
    seatDraws: number;
    /** Of those, draws accepted by the uniform escape (third attempt). */
    uniformEscapes: number;
  }>;
  readonly deck: Readonly<{
    physical: 'single_deck_excluding_hero_known_and_board';
    size: 36 | 52;
    /** Every dealt opponent consumes unknown cards, folded seats included. */
    dealtOpponents: number;
    /** The hero's private accepted discard excluded from the deck (Pineapple
     * after the discard: 1; otherwise 0). A count, never the card. */
    heroKnownDeadCards: 0 | 1;
  }>;
  /** Crazy Pineapple only; null for the other three packs. */
  readonly discard: Readonly<{
    opponents: 'declared_flop_only_structural_prior';
    /** The hero's pair: the accepted private discard after the flop, or the
     * same declared prior when sampled before it. */
    hero: 'accepted_private_discard' | 'declared_flop_only_structural_prior';
    actualOpponentDiscardsRead: false;
  }> | null;
  readonly work: Readonly<{
    requestedSamples: number;
    completedSamples: number;
    budgetExhausted: boolean;
  }>;
  /** The contesting opponents scored at showdown, with the public counts read. */
  readonly opponents: ReadonlyArray<
    Readonly<{ userId: string; seat: number; raises: number; calls: number }>
  >;
}

/** The shared pot-share evidence with the Phase 12 sampler's own provenance. */
export type RemainingVariantEquityEvidence = Omit<OmahaVariantEquityEvidence, 'range'> & {
  /** P12.1: the live sampler's range provenance; absent on external evidence. */
  range?: RemainingVariantRangeProvenance;
};

/** A bounded flop-only public prior for the opponent's Crazy Pineapple
 * discard. The final board is deliberately not an input. All three original
 * cards consume the deck, including the card this heuristic throws away.
 * This is a declared structural heuristic, not optimal discard equity. */
export function choosePineappleFlopPair(cards: Card[], flop: Card[]): Card[] {
  remainingVariantHandShape('pineapple', cards);
  if (
    flop.length !== 3 ||
    new Set([...cards, ...flop].map((c) => c.rank + ':' + c.suit)).size !== 6
  )
    throw new Error('Pineapple prior requires one physical three-card flop');
  let best = -Infinity,
    retained: Card[] = [];
  for (let discard = 0; discard < 3; discard++) {
    const pair = cards.filter((_, i) => i !== discard);
    const all = [...pair, ...flop];
    const score = scoreHoldem(all, 5, false),
      category = Math.floor(score / 0x100000);
    const flushDraw = SUITS.some(
      (s) => all.filter((c) => c.suit === s).length === 4 && pair.some((c) => c.suit === s)
    );
    const values = new Set(
      all.flatMap((c) => (c.rank === 'A' ? [1, 14] : [RANKS.indexOf(c.rank) + 2]))
    );
    let straightDraw = false;
    for (let top = 5; top <= 14; top++)
      if (Array.from({ length: 5 }, (_, i) => top - i).filter((r) => values.has(r)).length === 4)
        straightDraw = true;
    const value =
      category * 0.3 +
      ((score % 0x100000) / 0x100000) * 0.1 +
      Number(flushDraw) * 0.32 +
      Number(straightDraw) * 0.16 +
      remainingVariantHandShape('pineapple', pair, true).quality * 0.12;
    if (value > best) {
      best = value;
      retained = pair;
    }
  }
  return retained.map((c) => ({ ...c }));
}

/** P12.1: the terminal showdowns this sampler scored, offered to a caller
 * that needs the individual runouts rather than their aggregate share. The
 * roster is the contesting order the opponent arrays are indexed by, which is
 * the only order those arrays can legally be read in. Retention is additive:
 * the returned aggregate evidence is unchanged whether or not it is asked for,
 * and no extra sample, card or iteration is drawn to supply it. */
export interface RemainingVariantTerminalShowdowns {
  samples: HorseEquityOutcomeSample[];
  opponentIds: string[];
}

/** One physical deck, local RNG, bounded sequential public-line prior with a
 * declared uniform escape. Folded dealt seats still consume their full deal.
 * Hero's private known discard is excluded; opponents' private cards and
 * discards are never read. The consumer owns domain and legal validation. */
export function sampleRemainingVariantEquity(
  variant: RemainingPolicyVariant,
  hero: SeatPlayer,
  state: HorseGameStateV2,
  withinBudget: () => boolean,
  retain?: (showdowns: RemainingVariantTerminalShowdowns) => void
): RemainingVariantEquityEvidence | null {
  const started = performance.now(),
    pack = REMAINING_VARIANT_PACKS[variant];
  const postDiscard = variant === 'pineapple' && state.communityCards.length >= 3;
  try {
    remainingVariantHandShape(variant, hero.cards, postDiscard);
  } catch {
    return null;
  }
  const dead = hero.knownDeadCards ?? [];
  if (
    !Array.isArray(dead) ||
    dead.length !== (postDiscard ? 1 : 0) ||
    ![0, 3, 4, 5].includes(state.communityCards.length)
  )
    return null;
  const knownCards = [...hero.cards, ...dead, ...state.communityCards];
  const known = new Set(knownCards.map((c) => c.rank + ':' + c.suit));
  if (
    known.size !== knownCards.length ||
    knownCards.some(
      (c) =>
        !c ||
        !RANKS.includes(c.rank) ||
        !SUITS.includes(c.suit) ||
        (variant === 'short_deck' && RANKS.indexOf(c.rank) < 4)
    )
  )
    return null;
  let players: SeatPlayer[];
  try {
    players = horsePolicyDealtPlayers(state.players, hero.seat, state.dealtSeatIds);
  } catch {
    return null;
  }
  const dealt = players
    .filter((p) => p.user_id !== hero.user_id)
    .slice()
    .sort((a, b) => a.seat - b.seat);
  const active = dealt.filter((p) => !p.is_folded && (!p.is_sitting_out || p.is_all_in));
  const deck: Card[] = SUITS.flatMap((suit) =>
    RANKS.filter((rank) => variant !== 'short_deck' || RANKS.indexOf(rank) >= 4).map((rank) => ({
      rank,
      suit,
    }))
  ).filter((c) => !known.has(c.rank + ':' + c.suit));
  if (!active.length || dealt.length * pack.holes + 5 - state.communityCards.length > deck.length)
    return null;
  let stream = saveFastRandom() ^ 0x51a7e12;
  for (const card of knownCards)
    for (const char of card.rank + ':' + card.suit)
      stream = Math.imul(stream ^ char.charCodeAt(0), 16777619);
  stream = stream >>> 0 || 1;
  const random = () => {
    stream ^= stream << 13;
    stream ^= stream >>> 17;
    stream ^= stream << 5;
    return (stream >>> 0) / 0x100000000;
  };
  const reads = new Map(
    dealt.map((p) => {
      const line = (state.actionHistory ?? []).filter((a) => a.userId === p.user_id);
      return [
        p.user_id,
        {
          raises: line.filter(
            (a) =>
              ['bet', 'raise'].includes(a.action) ||
              (a.action === 'all_in' && a.isFullRaise !== undefined)
          ).length,
          calls: line.filter(
            (a) => a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined)
          ).length,
        },
      ];
    })
  );
  // The measured policy's sample, always (2026-10-09): the P12.2 matrix priced
  // every proposal at scale 1, and the P12.3 completion floor admits a pack
  // only when its live decisions price that same sample. Governor scaling made
  // about 4% of natural postflop decisions governor-reduced on release
  // c1deef24. Load stays bounded by the sampler's own deadline.
  const requested = remainingVariantRequestedSamples(1);
  const samples: HorseEquityOutcomeSample[] = [];
  // P12.1: what the prior actually did, recorded with the sample it produced.
  let seatDraws = 0;
  let uniformEscapes = 0;
  sampleLoop: for (let iteration = 0; iteration < requested; iteration++) {
    if (!withinBudget()) break;
    let remaining = deck.slice();
    const hands = new Map<string, Card[]>();
    let iterationEscapes = 0;
    for (const p of dealt) {
      if (!withinBudget()) break sampleLoop;
      const read = reads.get(p.user_id)!;
      for (let attempt = 0; attempt < 3; attempt++) {
        const trial = remaining.slice();
        const cards = Array.from(
          { length: pack.holes },
          () => trial.splice(Math.floor(random() * trial.length), 1)[0]
        );
        const weight = Math.pow(
          0.3 + remainingVariantHandShape(variant, cards).quality * 0.7,
          Math.min(4, 1 + read.raises * 0.6 + read.calls * 0.1)
        );
        if (attempt === 2 || random() <= weight) {
          if (attempt === 2) iterationEscapes++;
          remaining = trial;
          hands.set(p.user_id, cards);
          break;
        }
      }
    }
    // Deal the flop before making discard choices; the future turn and river
    // cannot influence which two cards survive, even in a preflop sample.
    const board = state.communityCards.slice();
    while (board.length < 3)
      board.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
    const heroHand =
      variant === 'pineapple' && hero.cards.length === 3
        ? choosePineappleFlopPair(hero.cards, board.slice(0, 3))
        : hero.cards;
    if (variant === 'pineapple')
      for (const p of dealt)
        hands.set(p.user_id, choosePineappleFlopPair(hands.get(p.user_id)!, board.slice(0, 3)));
    while (board.length < 5)
      board.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
    const high = (cards: Card[]) =>
      variant === 'flo8'
        ? scoreOmahaHi(cards, board)
        : scoreHoldem([...cards, ...board], cards.length + board.length, variant === 'short_deck');
    const low = (cards: Card[]) => {
      const v = pack.splitLow ? scoreOmahaLow(cards, board) : Infinity;
      return Number.isFinite(v) ? v : null;
    };
    // Counted only for a completed sample: an iteration cut by the budget
    // contributes no showdown and no draw.
    seatDraws += dealt.length;
    uniformEscapes += iterationEscapes;
    samples.push({
      heroHigh: high(heroHand),
      heroLow: low(heroHand),
      opponentHigh: active.map((p) => high(hands.get(p.user_id)!)),
      opponentLow: active.map((p) => low(hands.get(p.user_id)!)),
      opponentDecisionStrength: active.map(
        (p) =>
          remainingVariantHandShape(variant, hands.get(p.user_id)!, variant === 'pineapple').quality
      ),
    });
  }
  retain?.({ samples, opponentIds: active.map((p) => p.user_id) });
  const evidence = variantEquityFromShowdowns({
    variant,
    players: state.players,
    heroId: hero.user_id,
    callCost: Math.min(hero.stack, Math.max(0, state.currentBet - hero.bet)),
    opponentIds: active.map((p) => p.user_id),
    samples,
  }) as RemainingVariantEquityEvidence | null;
  if (evidence) {
    evidence.analysisMs = performance.now() - started;
    evidence.provenance = 'variant_public_line_joint_deck';
    evidence.requestedSamples = requested;
    evidence.sampleBudgetExhausted = samples.length < requested;
    evidence.range = Object.freeze({
      version: 'remaining-variant-range-provenance-v1',
      source: 'variant_public_line_sequential_prior',
      calibration: 'uncalibrated',
      solverInput: false,
      reads: 'public_action_line_only',
      prior: Object.freeze({
        attemptsPerSeat: 3,
        finalAttempt: 'uniform_escape',
        seatDraws,
        uniformEscapes,
      }),
      deck: Object.freeze({
        physical: 'single_deck_excluding_hero_known_and_board',
        size: pack.deck as 36 | 52,
        dealtOpponents: dealt.length,
        heroKnownDeadCards: dead.length as 0 | 1,
      }),
      discard:
        variant === 'pineapple'
          ? Object.freeze({
              opponents: 'declared_flop_only_structural_prior',
              hero:
                hero.cards.length === 3
                  ? 'declared_flop_only_structural_prior'
                  : 'accepted_private_discard',
              actualOpponentDiscardsRead: false,
            })
          : null,
      work: Object.freeze({
        requestedSamples: requested,
        completedSamples: samples.length,
        budgetExhausted: samples.length < requested,
      }),
      opponents: Object.freeze(
        active.map((p) => {
          const read = reads.get(p.user_id)!;
          return Object.freeze({
            userId: p.user_id,
            seat: p.seat,
            raises: read.raises,
            calls: read.calls,
          });
        })
      ),
    } satisfies RemainingVariantRangeProvenance);
  }
  return evidence;
}
