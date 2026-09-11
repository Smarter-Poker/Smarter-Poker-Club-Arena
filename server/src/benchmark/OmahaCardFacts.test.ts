import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import { omahaCardFacts } from '../engine/omaha/OmahaCardFacts.js';
import { referenceOmaha, referenceDeck } from './OmahaReference.js';
const cards = (s: string): Card[] =>
  s.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[c[1] as 'c'],
  }));
const key = (c: Card) => c.rank + c.suit;
describe('Phase 9 exact Omaha card components', () => {
  it('separates category-best flushes and straights from physical straight-flush nuts', () => {
    const board = cards('Js Ts 9s 2d 3h');
    const flush = omahaCardFacts(cards('As 2s Kc Qd'), board);
    expect(flush.flushes[0].higherFlushPossible).toBe(false);
    expect(flush.opponentStraightFlushHigh).toBe(13);
    expect(flush.nutStraightFlush).toBe(false);
    const nuts = omahaCardFacts(cards('Ks Qs 4c 5d'), board);
    expect(nuts.straightFlushHigh).toBe(13);
    expect(nuts.nutStraightFlush).toBe(true);
    // An unrelated higher offsuit straight cannot beat a straight flush.
    const seven = omahaCardFacts(cards('6s 7s 2c 3d'), cards('3s 4s 5s 8c 9d'));
    expect(seven.straightFlushHigh).toBe(7);
    expect(seven.nutStraightFlush).toBe(true);
  });
  it.each(['As Ah Ad Ac 2s', 'As Ah Ad Ac 2s 6s'])(
    'retains the nut low when %s removes every possible opponent tie',
    (text) => {
      // These are factual component inputs, not enabled five/six-card low games.
      const hole = cards(text),
        board = cards('3h 4c 5d Kh');
      const facts = omahaCardFacts(hole, board);
      expect(facts.nutLow).toBe(true);
      for (const transition of facts.nextCards) {
        const next = [...board, transition.card];
        const known = new Set([...hole, ...next].map(key));
        const available = referenceDeck().filter((c) => !known.has(key(c)));
        const lows = [
          ...new Map(
            available.filter((c) => 'A2345678'.includes(c.rank)).map((c) => [c.rank, c])
          ).values(),
        ];
        const fillers = available.filter((c) => c.rank === 'Q').slice(0, 2);
        let best = Infinity;
        for (let i = 0; i < lows.length; i++)
          for (let j = i + 1; j < lows.length; j++)
            best = Math.min(
              best,
              referenceOmaha([lows[i], lows[j], ...fillers], next).low ?? Infinity
            );
        const own = referenceOmaha(hole, next).low;
        expect(transition.nutLow).toBe(own !== null && own <= best);
      }
    }
  );
  it('independently agrees on every physical next-card straight in a wrap', () => {
    const hole = cards('As Ks Qd 9h'),
      board = cards('Js Tc 2d');
    const facts = omahaCardFacts(hole, board);
    const used = new Set([...hole, ...board].map(key));
    const reference = referenceDeck().filter(
      (c) => !used.has(key(c)) && referenceOmaha(hole, [...board, c]).category === 5
    );
    expect(facts.straightOutCards.map(key).sort()).toEqual(reference.map(key).sort());
    expect(facts.wrapOutCount).toBe(16);
    expect(facts.nextCards).toHaveLength(45);
    expect(facts.nutStraightOutCards.length).toBeLessThanOrEqual(facts.wrapOutCount);
  });
  it('uses two own cards for suit domination and exact set blockers', () => {
    const dominated = omahaCardFacts(cards('9s 8s Kd Qd'), cards('As 7s 2c'));
    expect(dominated.flushes.find((f) => f.suit === 'spades')).toMatchObject({
      draw: true,
      higherFlushPossible: true,
    });
    const blockerOnly = omahaCardFacts(cards('Ks 8h Kd Qd'), cards('As 7s 2c'));
    expect(blockerOnly.nutFlushBlockerSuits).toContain('spades');
    expect(blockerOnly.flushes.some((f) => f.suit === 'spades')).toBe(false);
    const set = omahaCardFacts(cards('Kh Kd 3s 2s'), cards('Kc 9s 8d'));
    expect(set.setRanks).toEqual(['K']);
    expect(set.setBlockers.find((b) => b.rank === 'K')).toMatchObject({
      held: 2,
      availableOpponentPairs: 0,
    });
    expect(set.nextCards.some((c) => c.pairsBoard)).toBe(true);
  });
  it('distinguishes counterfeit exposure from a protected backup low', () => {
    const board = cards('4c 5d 7h');
    const exposed = omahaCardFacts(cards('As 2s Kh Kd'), board);
    const protectedLow = omahaCardFacts(cards('As 2s 3h Kd'), board);
    expect(exposed.nutLow).toBe(true);
    expect(protectedLow.nutLow).toBe(true);
    expect(exposed.counterfeitTransitions.find((t) => t.card.rank === 'A')?.nutLowAfter).toBe(
      false
    );
    expect(protectedLow.counterfeitTransitions.find((t) => t.card.rank === 'A')?.nutLowAfter).toBe(
      true
    );
    expect(protectedLow.hasBackupLowCards).toBe(true);
  });
  it('reports gap, wrap and redraw facts without labeling them probabilities', () => {
    const connected = omahaCardFacts(cards('Qs Jh Td 9c'), []);
    expect(connected.rankGaps).toEqual([0, 0, 0]);
    expect(connected.rankSpan).toBe(3);
    expect(connected.calibratedDominationProbability).toBeNull();
    const draws = omahaCardFacts(cards('Kh Kd Qs Js'), cards('Kc Ts 2s'));
    expect(draws.setRanks).toEqual(['K']);
    expect(draws.straightOutCards.length).toBeGreaterThan(0);
    expect(draws.flushes.some((f) => f.draw)).toBe(true);
  });
  it('compares low qualification against independent exact-card scores over all transitions', () => {
    for (const hand of ['As 2s 3h Kd', 'As Ad 2s 2h', '8s 7s 6h 5d']) {
      const hole = cards(hand),
        board = cards('4c 5c 9d');
      for (const transition of omahaCardFacts(hole, board).nextCards)
        expect(transition.qualifiesLow).toBe(
          referenceOmaha(hole, [...board, transition.card]).low !== null
        );
    }
  });
  it('rejects duplicate/malformed cards and ends next-card transitions at the river', () => {
    expect(() => omahaCardFacts(cards('As As Kh Kd'), [])).toThrow();
    expect(omahaCardFacts(cards('As 2s Kh Kd'), cards('4c 5c 9d Th Jh')).nextCards).toEqual([]);
  });
});
