/**
 * pot_distributed names who got each pot - EXACTLY (2026-09-14).
 *
 * The per-winner share was an estimate: each winner's whole-hand total scaled
 * into every pot they were eligible for. Exact for one pot on one board;
 * wrong for a three-way all-in run twice where the main pot split on board
 * one and the side pot went one way on both. The per-pot award slices carry
 * the truth; buildPotDistribution reads them and keeps the estimate only for
 * a pot with no slices. Shares are cents, and they sum to the pot.
 */
import { describe, it, expect } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'abababab-abab-abab-abab-abababababab';

type Dist = Array<{
  pot_index: number;
  amount: number;
  winner_user_ids: string[];
  per_winner_share: Array<{ user_id: string; share: number }>;
}>;

function build(
  pots: Array<{ amount: number; eligiblePlayers?: string[] }>,
  winners: Array<{ userId: string; amount: number }>,
  awards: Array<{ pot_index: number; winners: Array<{ user_id: string; amount: number }> }>
): Dist {
  const e = new ServerTableEngine(TABLE) as unknown as {
    buildPotDistribution: (p: unknown, w: unknown, a: unknown) => Dist;
  };
  return e.buildPotDistribution(pots, winners, awards);
}

const sum = (d: Dist[number]) => d.per_winner_share.reduce((s, x) => s + x.share, 0);

describe('buildPotDistribution', () => {
  it('a three-way all-in run twice: the main pot split is the main pot split, not the totals', () => {
    // Main pot 300 (A, B, C eligible), side pot 400 (B, C eligible).
    // Board 1: A wins the main pot, C wins the side pot.
    // Board 2: B wins the main pot, C wins the side pot.
    // Post-rake display slices (5% rake): main 142.50 per board, side 190 per board.
    const awards = [
      { pot_index: 0, winners: [{ user_id: 'A', amount: 142.5 }] },
      { pot_index: 1, winners: [{ user_id: 'C', amount: 190 }] },
      { pot_index: 0, winners: [{ user_id: 'B', amount: 142.5 }] },
      { pot_index: 1, winners: [{ user_id: 'C', amount: 190 }] },
    ];
    const winners = [
      { userId: 'A', amount: 142.5 },
      { userId: 'B', amount: 142.5 },
      { userId: 'C', amount: 380 },
    ];
    const pots = [
      { amount: 300, eligiblePlayers: ['A', 'B', 'C'] },
      { amount: 400, eligiblePlayers: ['B', 'C'] },
    ];
    const d = build(pots, winners, awards);
    expect(d[0].winner_user_ids.sort()).toEqual(['A', 'B']);
    expect(d[0].per_winner_share.find((s) => s.user_id === 'A')?.share).toBe(150);
    expect(d[0].per_winner_share.find((s) => s.user_id === 'B')?.share).toBe(150);
    // C never won the main pot; the old estimate would have handed him the
    // largest slice of it because his TOTAL was the largest.
    expect(d[0].per_winner_share.some((s) => s.user_id === 'C')).toBe(false);
    expect(d[1].winner_user_ids).toEqual(['C']);
    expect(d[1].per_winner_share).toEqual([{ user_id: 'C', share: 400 }]);
    expect(sum(d[0])).toBe(300);
    expect(sum(d[1])).toBe(400);
  });

  it('shares are cents that sum to the pot, the remainder to the largest share', () => {
    const d = build(
      [{ amount: 100, eligiblePlayers: ['A', 'B', 'C'] }],
      [
        { userId: 'A', amount: 40 },
        { userId: 'B', amount: 30 },
        { userId: 'C', amount: 30 },
      ],
      [
        {
          pot_index: 0,
          winners: [
            { user_id: 'A', amount: 10 },
            { user_id: 'B', amount: 10 },
            { user_id: 'C', amount: 10 },
          ],
        },
      ]
    );
    const shares = d[0].per_winner_share;
    for (const s of shares) {
      expect(Math.abs(s.share * 100 - Math.round(s.share * 100))).toBeLessThan(1e-9);
    }
    expect(Math.round(sum(d[0]) * 100)).toBe(10000);
    // A third of 100.00 is 33.33 with one cent over; equal weights keep
    // award order, so the first slice takes it. Nothing is lost or invented.
    expect(shares.map((s) => [s.user_id, s.share])).toEqual([
      ['A', 33.34],
      ['B', 33.33],
      ['C', 33.33],
    ]);
  });

  it('a pot with no award slices falls back to the eligible-winner estimate, in cents', () => {
    const d = build(
      [
        { amount: 200, eligiblePlayers: ['A', 'B'] },
        { amount: 50, eligiblePlayers: ['B'] },
      ],
      [
        { userId: 'A', amount: 100 },
        { userId: 'B', amount: 137.5 },
      ],
      []
    );
    expect(d[0].winner_user_ids).toEqual(['A', 'B']);
    expect(Math.round(sum(d[0]) * 100)).toBe(20000);
    expect(d[1].winner_user_ids).toEqual(['B']);
    expect(d[1].per_winner_share).toEqual([{ user_id: 'B', share: 50 }]);
  });

  it('a pot nobody eligible won is reported empty, never invented', () => {
    const d = build([{ amount: 80, eligiblePlayers: ['Z'] }], [{ userId: 'A', amount: 80 }], []);
    expect(d[0].winner_user_ids).toEqual([]);
    expect(d[0].per_winner_share).toEqual([]);
    expect(d[0].amount).toBe(80);
  });
});
