/**
 * PHASE 2 — the forced discard keeps the best HAND, not the best FLOP.
 *
 * `resolvePendingPineappleDiscards` is the auto-resolve for a seat that was
 * already all-in when the flop landed, so it never got to choose. It used to
 * score the flop-MADE hand and keep the highest of those, which is backwards in
 * the only situation it runs: an all-in has two more cards coming and no more
 * betting, which is exactly when a draw is worth the most it will ever be
 * worth.
 *
 * It also disagreed with HorseLogic.decideDiscard, which has always priced by
 * equity. CLAUDE.md 10.5 requires a horse and a human to be treated identically
 * and a decision made by two different rules cannot be, so there is one chooser
 * now and both callers use it.
 */
import { describe, it, expect } from 'vitest';
import { bestPineappleDiscard } from './pineappleDiscardChoice.js';
import { HorseLogic } from './HorseLogic.js';
import { evaluateHand } from './PokerEngine.js';
import type { Card } from '../types.js';

const C = (s: string): Card => ({ rank: s.slice(0, -1), suit: s.slice(-1) }) as Card;
const hand = (...s: string[]) => s.map(C);

/** The rule this replaced: highest flop-MADE hand wins. */
function bestByFlopMadeHand(cards: Card[], flop: Card[]): number {
  let bestIdx = 2;
  let bestScore = -1;
  for (let d = 0; d < 3; d++) {
    const keep = cards.filter((_, i) => i !== d);
    const e = evaluateHand(keep, flop);
    const score = e.ranking * 1e6 + (e.kickers[0] || 0) * 1e3 + (e.kickers[1] || 0);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = d;
    }
  }
  return bestIdx;
}

describe('the forced discard keeps the hand with the most equity', () => {
  it('keeps the nut flush draw over a pair of nothing', () => {
    // A(h) K(h) 2(c) on 7(h) 8(h) 3(c).
    //   keep AhKh -> nut flush draw + two overcards
    //   keep Ah2c / Kh2c -> no pair, no draw
    // The OLD rule scored made hands on the flop, where none of these pairs
    // anything, so it fell through to its default and threw the last card.
    const cards = hand('Ah', 'Kh', '2c');
    const flop = hand('7h', '8h', '3c');
    const idx = bestPineappleDiscard(cards, flop, 'pineapple', 2000);
    expect(cards[idx]).toEqual(C('2c'));
  });

  it('keeps a made set over a bare overcard', () => {
    // 9(s) 9(d) A(c) on 9(h) 4(s) 2(c): trip nines is the hand, obviously.
    const cards = hand('9s', '9d', 'Ac');
    const flop = hand('9h', '4s', '2c');
    const idx = bestPineappleDiscard(cards, flop, 'pineapple', 2000);
    expect(cards[idx]).toEqual(C('Ac'));
  });

  it('throws a dead pair away to keep the nut draw - the case the old rule lost money on', () => {
    /* 2(s) 2(d) A(h) on K(h) J(h) T(h).
         keep A(h) + a deuce -> nut flush draw on a three-heart board, PLUS a
                                Broadway gutshot (any queen plays A-K-Q-J-T)
         keep 2(s) 2(d)      -> a pair of deuces, drawing nearly dead
       The old rule kept the DEUCES, every time: a pair outranks ace-high on the
       flop, and the flop was the only thing it looked at. On an all-in - the
       only place this code runs - there are two cards to come and no more
       betting, so this is the worst possible moment to be blind to a draw. */
    const cards = hand('2s', '2d', 'Ah');
    const flop = hand('Kh', 'Jh', 'Th');

    const old = bestByFlopMadeHand(cards, flop);
    expect(cards[old], 'the old rule threw the ace away').toEqual(C('Ah'));

    const now = bestPineappleDiscard(cards, flop, 'pineapple', 4000);
    expect(cards[now].rank, 'the ace is kept now').not.toBe('A');
    expect(old).not.toBe(now);
  });

  it('does not simply always keep the ace - it keeps whatever wins', () => {
    // Same shape, a board the ace has nothing to do with: 3(s) 3(d) A(h) on
    // 9(h) 8(h) 2(c). Here BOTH rules keep the pair, and they agree.
    const cards = hand('3s', '3d', 'Ah');
    const flop = hand('9h', '8h', '2c');
    expect(cards[bestPineappleDiscard(cards, flop, 'pineapple', 4000)]).toEqual(C('Ah'));
    expect(bestByFlopMadeHand(cards, flop)).toBe(2);
  });

  it('is the SAME function a horse uses - not merely the same answer', () => {
    const cards = hand('Ah', 'Kh', '2c');
    const flop = hand('7h', '8h', '3c');
    // Same seed-free deterministic inputs, same iteration budget, same result.
    expect(HorseLogic.decideDiscard(cards, flop, 'pineapple')).toBe(
      bestPineappleDiscard(cards, flop, 'pineapple')
    );
  });

  it('refuses an input it cannot answer, rather than guessing', () => {
    expect(bestPineappleDiscard(hand('Ah', 'Kh'), [], 'pineapple')).toBe(2);
    expect(bestPineappleDiscard([], [], 'pineapple')).toBe(2);
  });

  it('still answers before a flop, by preflop strength', () => {
    // A(s) A(d) 7(c) with no board: keep the aces.
    const cards = hand('As', 'Ad', '7c');
    const idx = bestPineappleDiscard(cards, [], 'pineapple');
    expect(cards[idx]).toEqual(C('7c'));
  });
});
