/**
 * The five cards that played.
 *
 * This evaluator is display-only - the engine decides pots - but a hand board
 * that draws the WRONG five cards is worse than drawing none, so the rules that
 * are easy to get wrong are pinned here: the wheel is five-high, Omaha must use
 * exactly two from hand and three from board, and category ordering must match
 * the engine's.
 */
import { describe, it, expect } from 'vitest';
import {
  bestFive,
  scoreFive,
  compareScore,
  CATEGORY,
  cardKey,
} from '../../src/utils/handEvaluator';
import type { Card } from '../../src/components/table/CardImage';

const c = (s: string): Card => ({ rank: s[0] as Card['rank'], suit: s[1] as Card['suit'] });
const hand = (s: string): Card[] => s.split(' ').map(c);
const keys = (cards: Card[]) => cards.map(cardKey).sort().join(' ');

describe('scoreFive - categories', () => {
  it('ranks every category in the right order', () => {
    const rows: Array<[string, number]> = [
      ['As Ks Qs Js Ts', CATEGORY.STRAIGHT_FLUSH],
      ['9h 9d 9c 9s 2h', CATEGORY.FOUR_OF_A_KIND],
      ['Ah Ad Ac Jh Jd', CATEGORY.FULL_HOUSE],
      ['Ah 9h 7h 4h 2h', CATEGORY.FLUSH],
      ['9h 8d 7c 6s 5h', CATEGORY.STRAIGHT],
      ['Qh Qd Qc 7s 2h', CATEGORY.THREE_OF_A_KIND],
      ['Kh Kd 4c 4s 9h', CATEGORY.TWO_PAIR],
      ['Kh Kd 9c 5s 2h', CATEGORY.PAIR],
      ['Ah Jd 9c 5s 2h', CATEGORY.HIGH_CARD],
    ];
    for (const [h, cat] of rows) expect(scoreFive(hand(h)).category).toBe(cat);
    for (let i = 1; i < rows.length; i++) {
      expect(
        compareScore(scoreFive(hand(rows[i - 1][0])), scoreFive(hand(rows[i][0])))
      ).toBeGreaterThan(0);
    }
  });

  it('the wheel is a FIVE-high straight, not an ace-high one', () => {
    const wheel = scoreFive(hand('Ah 5d 4c 3s 2h'));
    expect(wheel.category).toBe(CATEGORY.STRAIGHT);
    expect(wheel.tiebreak[0]).toBe(5);
    // Any other straight beats it, including the next one up.
    expect(compareScore(scoreFive(hand('6h 5d 4c 3s 2h')), wheel)).toBeGreaterThan(0);
  });

  it('a steel wheel is a straight flush, still five-high', () => {
    const sf = scoreFive(hand('Ah 5h 4h 3h 2h'));
    expect(sf.category).toBe(CATEGORY.STRAIGHT_FLUSH);
    expect(sf.tiebreak[0]).toBe(5);
    expect(compareScore(scoreFive(hand('9h 8h 7h 6h 5h')), sf)).toBeGreaterThan(0);
  });

  it('A-K-Q-J-T suited is named a Royal Flush', () => {
    expect(bestFive(hand('As Ks'), hand('Qs Js Ts 2h 3d'), 'nlh')!.name).toBe('Royal Flush');
  });

  it('compares within a category by the right tiebreakers', () => {
    // Aces full of kings beats aces full of queens.
    expect(
      compareScore(scoreFive(hand('Ah Ad Ac Kh Kd')), scoreFive(hand('As Ad Ac Qh Qd')))
    ).toBeGreaterThan(0);
    // Same pair, better kicker.
    expect(
      compareScore(scoreFive(hand('Kh Kd Ac 5s 2h')), scoreFive(hand('Ks Kc Qd 5h 2c')))
    ).toBeGreaterThan(0);
  });
});

describe("bestFive - hold'em", () => {
  it('picks the five that make the hand out of seven', () => {
    const best = bestFive(hand('Ah Kh'), hand('Qh Jh Th 2c 3d'), 'nlh')!;
    expect(best.name).toBe('Royal Flush');
    expect(keys(best.cards)).toBe(keys(hand('Ah Kh Qh Jh Th')));
  });

  it('plays the board when the hole cards do not improve it', () => {
    const best = bestFive(hand('2c 3d'), hand('Ah Kh Qh Jh Th'), 'nlh')!;
    expect(best.name).toBe('Royal Flush');
    expect(keys(best.cards)).toBe(keys(hand('Ah Kh Qh Jh Th')));
  });

  it('returns null when there are fewer than five cards to work with', () => {
    expect(bestFive(hand('Ah Kh'), hand('Qh Jh'), 'nlh')).toBeNull();
    expect(bestFive([], [], 'nlh')).toBeNull();
  });
});

describe('bestFive - Omaha uses exactly two from hand and three from board', () => {
  it('does NOT let four hole cards make a flush', () => {
    // Freely picking five would take four hearts from the hand - illegal.
    const best = bestFive(hand('Ah Kh Qh Jh'), hand('2h 7h 9c 4d 5s'), 'plo4')!;
    // The legal best is two hearts from hand + three from the board... but the
    // board only holds two hearts, so no flush is possible at all here.
    expect(best.category).not.toBe(CATEGORY.FLUSH);
    const fromHole = best.cards.filter(
      (x) => keys([x]) !== '' && hand('Ah Kh Qh Jh').some((y) => cardKey(y) === cardKey(x))
    );
    expect(fromHole).toHaveLength(2);
  });

  it('always uses exactly two hole cards and three board cards', () => {
    const hole = hand('As Ad Kc 2h');
    const board = hand('Ac Ah 7d 9s 3c');
    const best = bestFive(hole, board, 'plo4')!;
    const fromHole = best.cards.filter((x) => hole.some((y) => cardKey(y) === cardKey(x)));
    const fromBoard = best.cards.filter((x) => board.some((y) => cardKey(y) === cardKey(x)));
    expect(fromHole).toHaveLength(2);
    expect(fromBoard).toHaveLength(3);
    // Two aces in hand + two on the board is quad aces, legally reachable.
    expect(best.category).toBe(CATEGORY.FOUR_OF_A_KIND);
  });

  it('handles a five-card PLO5 holding', () => {
    const best = bestFive(hand('8s 7s 6s 5s 4s'), hand('2h 3d 9c Kd Qh'), 'plo5')!;
    const fromHole = best.cards.filter((x) =>
      hand('8s 7s 6s 5s 4s').some((y) => cardKey(y) === cardKey(x))
    );
    expect(fromHole).toHaveLength(2);
  });

  it('needs two hole cards and three board cards or it declines to guess', () => {
    expect(bestFive(hand('Ah'), hand('Kh Qh Jh Th 9h'), 'plo4')).toBeNull();
    expect(bestFive(hand('Ah Kh Qh Jh'), hand('Th 9h'), 'plo4')).toBeNull();
  });
});

describe('bestFive - card order for display', () => {
  it('leads with the cards that define the hand, kickers after', () => {
    const best = bestFive(hand('9h 9d'), hand('9c 9s Ah 2d 3c'), 'nlh')!;
    expect(best.name).toBe('Four of a Kind');
    expect(best.cards.slice(0, 4).every((x) => x.rank === '9')).toBe(true);
    expect(best.cards[4].rank).toBe('A');
  });

  it('orders a full house as trips then the pair', () => {
    const best = bestFive(hand('Ah Ad'), hand('Ac Jh Jd 2c 3s'), 'nlh')!;
    expect(best.name).toBe('Full House');
    expect(best.cards.slice(0, 3).every((x) => x.rank === 'A')).toBe(true);
    expect(best.cards.slice(3).every((x) => x.rank === 'J')).toBe(true);
  });
});

describe('the real jackpot hand from production', () => {
  it('PLO5: an 8-high straight flush loses to a royal', () => {
    const board = hand('9s Qd Td Ks Jd');
    const badBeat = bestFive(hand('9c Th 8d 2d 9d'), board, 'plo5');
    const winner = bestFive(hand('8c Kd As Ad Ah'), board, 'plo5');
    expect(winner).not.toBeNull();
    expect(badBeat).not.toBeNull();
    expect(compareScore(winner!, badBeat!)).toBeGreaterThan(0);
  });
});
