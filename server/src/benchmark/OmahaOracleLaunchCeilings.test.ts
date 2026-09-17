import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import { maxSeatsFor } from '../engine/VariantRules.js';
import { evaluateOmahaEquity, type OmahaEquityRequest } from './OmahaEquityOracle.js';

const suits = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const;
function cards(text: string): Card[] {
  return text.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: suits[c[1] as keyof typeof suits],
  }));
}

function fullTable(
  variant: 'plo4' | 'flo8',
  chipUnit: 0.01 | 1,
  board: Card[],
  fixedHands: Card[][]
): OmahaEquityRequest {
  // Same final MTT ceiling as TournamentManagerBase, rather than the cash cap.
  const seats = Math.min(10, maxSeatsFor(variant));
  expect(seats).toBe(10);
  const used = new Set([...board, ...fixedHands.flat()].map((c) => c.rank + ':' + c.suit));
  expect(used.size).toBe(board.length + fixedHands.length * 4);
  // Independent physical fixture construction; no production evaluator or
  // reference settlement produces the economic expectations below.
  const deck: Card[] = [];
  for (const suit of Object.values(suits))
    for (const rank of '23456789TJQKA')
      if (!used.has(rank + ':' + suit)) deck.push({ rank: rank as Card['rank'], suit });
  const contributions = [100, 60, 160, 160, 80, 100, 100, 100, 100, 200];
  return {
    variant,
    heroId: 'p0',
    players: contributions.map((units, i) => ({
      id: 'p' + i,
      seat: i + 1,
      contributed: units * chipUnit,
      folded: i === 8,
      range: { combos: [{ cards: fixedHands[i] ?? deck.splice(0, 4), weight: 1 }] },
    })),
    boards: [board],
    chipUnit,
    dealerSeat: seats,
    mode: 'exact_river',
    samples: 1,
    seed: 901991,
  };
}

describe('Phase 9 oracle at actual PLO4/FLO8 maximum tournament occupancy', () => {
  for (const variant of ['plo4', 'flo8'] as const)
    for (const chipUnit of [0.01, 1] as const)
      it(`${variant}, ten dealt seats, unit ${chipUnit}: a unique royal wins only eligible layers`, async () => {
        const request = fullTable(variant, chipUnit, cards('Qs Js Ts 4c 5d'), [
          cards('As Ks 2c 3d'),
        ]);
        const result = await evaluateOmahaEquity(request);
        // Exactly As/Ks + Qs/Js/Ts is the unique royal. No board low can
        // qualify. Hero's 100-unit contribution admits the 600,180,160
        // layers, including folded p8's dead100. It excludes the last180;
        // p9 receives its uncalled40 separately. No scorer derives this.
        expect(result.complete).toBe(true);
        expect(result.samples).toBe(1);
        expect(result.attempts).toBe(1);
        expect(result.eligiblePot).toBeCloseTo(940 * chipUnit, 8);
        expect(result.expectedChips).toBeCloseTo(940 * chipUnit, 8);
        expect(result.equity).toBe(1);
        expect(result.highEquity).toBe(1);
        expect(result.lowEquity).toBe(0);
        expect(result.refunds).toEqual({ p9: 40 * chipUnit });
        // Per-pot diagnostics intentionally report only hero-eligible layers.
        expect(result.perPot.map((p) => p.amount / chipUnit)).toEqual([600, 180, 160]);
        expect(result.perPot[0].eligiblePlayers).toHaveLength(9);
        expect(result.perPot.every((p) => !p.eligiblePlayers.includes('p8'))).toBe(true);
        expect(result.perPot.every((p) => p.eligiblePlayers.includes('p0'))).toBe(true);
        expect(result.maxConservationError).toBeLessThan(1e-6);
      });

  it('FLO8 at ten seats gives the unique wheel its low half and its uncontested higher layers', async () => {
    const request = fullTable('flo8', 1, cards('3c 4d 5h Kc Qh'), [
      cards('As 2s Jh Td'), // Unique wheel low; five-high straight.
      cards('6s 7s 9c 9d'), // Unique seven-high straight, but only60 invested.
      cards('6c 6d 6h 8c'), // All other sixes cannot meet a seven or deuce.
      cards('7c 7d 7h 8d'),
      cards('Ac Ad Ah 8h'), // Keep every remaining ace away from every deuce.
      cards('2c 2d 2h 8s'),
    ]);
    const result = await evaluateOmahaEquity(request);
    // Main600: p1 high300, hero low300. Above p1's60 contribution,
    // hero's wheel scoops the180 and160 layers. Final180 is ineligible.
    expect(result.complete).toBe(true);
    expect(result.samples).toBe(1);
    expect(result.eligiblePot).toBe(940);
    expect(result.expectedChips).toBe(640);
    expect(result.highEquity).toBeCloseTo(170 / 940, 12);
    expect(result.lowEquity).toBe(0.5);
    expect(result.equity).toBeCloseTo(640 / 940, 12);
    expect(result.refunds).toEqual({ p9: 40 });
    expect(result.perPot[0].eligiblePlayers).toHaveLength(9);
    expect(result.perPot.every((p) => !p.eligiblePlayers.includes('p8'))).toBe(true);
    expect(result.maxConservationError).toBe(0);
  });
});
