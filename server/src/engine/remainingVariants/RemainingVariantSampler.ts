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
import { equityGovernor } from '../EquityLoadGovernor.js';
import { variantEquityFromShowdowns } from '../omaha/OmahaVariantEquity.js';
import {
  REMAINING_VARIANT_PACKS,
  remainingVariantHandShape,
  type RemainingPolicyVariant,
} from './RemainingVariantPolicyPack.js';

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

/** One physical deck, local RNG, bounded sequential public-line prior with a
 * declared uniform escape. Folded dealt seats still consume their full deal.
 * Hero's private known discard is excluded; opponents' private cards and
 * discards are never read. The consumer owns domain and legal validation. */
export function sampleRemainingVariantEquity(
  variant: RemainingPolicyVariant,
  hero: SeatPlayer,
  state: HorseGameStateV2,
  withinBudget: () => boolean
) {
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
  const dealt = state.players
    .filter((p) => !p.is_sitting_out && p.user_id !== hero.user_id)
    .slice()
    .sort((a, b) => a.seat - b.seat);
  const active = dealt.filter((p) => !p.is_folded);
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
  const requested = Math.max(
    4,
    Math.floor(32 * Math.min(1, Math.max(0, equityGovernor.current())))
  );
  const samples: HorseEquityOutcomeSample[] = [];
  sampleLoop: for (let iteration = 0; iteration < requested; iteration++) {
    if (!withinBudget()) break;
    let remaining = deck.slice();
    const hands = new Map<string, Card[]>();
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
  const evidence = variantEquityFromShowdowns({
    variant,
    players: state.players,
    heroId: hero.user_id,
    callCost: Math.min(hero.stack, Math.max(0, state.currentBet - hero.bet)),
    opponentIds: active.map((p) => p.user_id),
    samples,
  });
  if (evidence) {
    evidence.analysisMs = performance.now() - started;
    evidence.provenance = 'variant_public_line_joint_deck';
    evidence.requestedSamples = requested;
    evidence.sampleBudgetExhausted = samples.length < requested;
  }
  return evidence;
}
