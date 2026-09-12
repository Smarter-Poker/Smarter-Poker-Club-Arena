import type { Card, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { RANKS, SUITS } from '../PokerEngine.js';
import {
  saveFastRandom,
  scoreOmahaHi,
  scoreOmahaLow,
  omahaMadeClass,
  type HorseEquityOutcomeSample,
} from '../HorseEval.js';
import { equityGovernor } from '../EquityLoadGovernor.js';
import { omahaVariantEquityFromShowdowns } from './OmahaVariantEquity.js';
import {
  OMAHA_VARIANT_PACKS,
  omahaVariantHandShape,
  type OmahaPolicyVariant,
} from './OmahaVariantPolicyPack.js';

/** A separate bounded shadow read. Its local stream never advances the
 * baseline strategy stream. Public-line conditioning is an explicitly
 * heuristic sequential prior, not an independent solver-range posterior.
 * Folded dealt seats still consume unknown cards from the one physical deck.
 */
export function sampleOmahaVariantEquity(
  variant: OmahaPolicyVariant,
  hero: SeatPlayer,
  state: HorseGameStateV2,
  withinBudget: () => boolean
) {
  const started = performance.now();
  const pack = OMAHA_VARIANT_PACKS[variant];
  const dealt = state.players
    .filter((p) => !p.is_sitting_out && p.user_id !== hero.user_id)
    .slice()
    .sort((a, b) => a.seat - b.seat);
  const active = dealt.filter((p) => !p.is_folded);
  const known = new Set([...hero.cards, ...state.communityCards].map((c) => `${c.rank}:${c.suit}`));
  const deck: Card[] = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit }))).filter(
    (c) => !known.has(`${c.rank}:${c.suit}`)
  );
  if (!active.length || dealt.length * pack.holes + 5 - state.communityCards.length > deck.length)
    return null;
  let stream = saveFastRandom() ^ 0x51a7e11;
  for (const card of hero.cards)
    for (const char of `${card.rank}:${card.suit}`)
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
              a.action === 'bet' ||
              a.action === 'raise' ||
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
      // Up to three rejection attempts from the still-available deck. The
      // final attempt is a declared uniform escape, keeping sparse priors
      // from inventing impossible cards or starving wide tables.
      for (let attempt = 0; attempt < 3; attempt++) {
        const trial = remaining.slice();
        const cards = Array.from(
          { length: pack.holes },
          () => trial.splice(Math.floor(random() * trial.length), 1)[0]
        );
        const shape = omahaVariantHandShape(variant, cards);
        const contact = omahaMadeClass(cards, state.communityCards).category / 10;
        const signal = Math.min(1, shape.quality * 0.55 + contact * 0.45);
        const weight = Math.pow(
          0.3 + signal * 0.7,
          Math.min(4, 1 + read.raises * 0.6 + read.calls * 0.1)
        );
        if (attempt === 2 || random() <= weight) {
          remaining = trial;
          hands.set(p.user_id, cards);
          break;
        }
      }
    }
    const board = state.communityCards.slice();
    while (board.length < 5)
      board.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
    const low = (cards: Card[]) => {
      const value = pack.splitPot ? scoreOmahaLow(cards, board) : Infinity;
      return Number.isFinite(value) ? value : null;
    };
    samples.push({
      heroHigh: scoreOmahaHi(hero.cards, board),
      heroLow: low(hero.cards),
      opponentHigh: active.map((p) => scoreOmahaHi(hands.get(p.user_id)!, board)),
      opponentLow: active.map((p) => low(hands.get(p.user_id)!)),
      opponentDecisionStrength: active.map(
        (p) => omahaMadeClass(hands.get(p.user_id)!, state.communityCards).category / 10
      ),
    });
  }
  const evidence = omahaVariantEquityFromShowdowns({
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
