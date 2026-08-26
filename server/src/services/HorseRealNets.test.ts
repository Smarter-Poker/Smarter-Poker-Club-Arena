/**
 * V16 REAL NETS — the accumulator's arithmetic must be exact (it feeds the
 * self-tuner's regression rule), and the re-enabled bb100 rule must fire
 * only on a qualifying REAL sample.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: vi.fn(async () => ({ data: 1, error: null })), from: vi.fn() },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import { accumulateHorseNets, drainHorseNets, type HorseReviewInput } from './HorseHandReview.js';
import { diagnoseAndNudge, MIN_REAL_HANDS_FOR_BB100, type PlayStats } from './HorseSelfTuner.js';

function input(over: Partial<HorseReviewInput> = {}): HorseReviewInput {
  return {
    handId: 'h-1',
    tableId: 't-1',
    tournamentId: null,
    clubId: null,
    gameVariant: 'plo4',
    bigBlind: 2,
    playedAt: '2026-08-26T12:00:00.000Z',
    potSize: 40,
    board: null,
    holeCardsAll: new Map([
      ['horse-a', { seat: 1, cards: [] }],
      ['horse-b', { seat: 2, cards: [] }],
      ['human-1', { seat: 3, cards: [] }],
    ]),
    contributions: new Map([
      ['horse-a', 10],
      ['horse-b', 6],
      ['human-1', 4],
    ]),
    winners: [{ userId: 'horse-a', amount: 19 }],
    actions: [],
    roster: [
      { userId: 'horse-a', isHorse: true },
      { userId: 'horse-b', isHorse: true },
      { userId: 'human-1', isHorse: false },
    ],
    ...over,
  };
}

describe('accumulateHorseNets + drainHorseNets', () => {
  it('aggregates exact nets in bb per horse/day/variant/format', () => {
    drainHorseNets(10_000); // clear anything from other tests
    accumulateHorseNets(input());
    accumulateHorseNets(input({ handId: 'h-2', winners: [{ userId: 'horse-b', amount: 14 }] }));
    const rows = drainHorseNets();
    const a = rows.find((r) => r.horse_user_id === 'horse-a');
    const b = rows.find((r) => r.horse_user_id === 'horse-b');
    expect(rows).toHaveLength(2); // humans never appear
    // horse-a: hand1 +(19-10)=+9 chips, hand2 -10 chips -> -1 chips = -0.5bb over 2 hands
    expect(a).toMatchObject({ game_variant: 'plo4', format: 'cash', hands: 2, net_bb: -0.5 });
    // horse-b: hand1 -6, hand2 +(14-6)=+8 -> +2 chips = +1bb over 2 hands
    expect(b).toMatchObject({ hands: 2, net_bb: 1 });
    expect(a?.day).toBe('2026-08-26');
  });

  it('labels tournaments and heads-up correctly', () => {
    drainHorseNets(10_000);
    accumulateHorseNets(input({ tournamentId: 'tt-1' }));
    accumulateHorseNets(
      input({
        handId: 'h-3',
        holeCardsAll: new Map([
          ['horse-a', { seat: 1, cards: [] }],
          ['human-1', { seat: 3, cards: [] }],
        ]),
        roster: [
          { userId: 'horse-a', isHorse: true },
          { userId: 'human-1', isHorse: false },
        ],
      })
    );
    const rows = drainHorseNets();
    expect(rows.some((r) => r.format === 'tournament')).toBe(true);
    expect(rows.some((r) => r.format === 'hu_cash')).toBe(true);
  });

  it('drain empties the accumulator (a second drain returns nothing)', () => {
    drainHorseNets(10_000);
    accumulateHorseNets(input());
    expect(drainHorseNets().length).toBeGreaterThan(0);
    expect(drainHorseNets()).toHaveLength(0);
  });
});

describe('the regression rule on real bb100', () => {
  const stats: PlayStats = {
    hands: 5000,
    vpip: 1200,
    pfr: 800,
    threeBets: 100,
    threeBetOpps: 900,
    faced3Bets: 100,
    foldTo3Bets: 45,
    sawFlop: 2500,
    wonWhenSawFlop: 1150,
    postAggr: 900,
    postPassive: 600,
    netBB: 0,
  } as PlayStats;

  it('halves the dials toward neutral on a real -15bb100 sample', () => {
    const { mods, reasons } = diagnoseAndNudge(
      stats,
      { tightness: 1.1, aggression: 1.12, bluffFreq: 0.9 },
      -22,
      MIN_REAL_HANDS_FOR_BB100
    );
    expect(mods.tightness).toBeCloseTo(1.05, 5);
    expect(mods.aggression).toBeCloseTo(1.06, 5);
    expect(mods.bluffFreq).toBeCloseTo(0.95, 5);
    expect(reasons.join(' ')).toContain('real bb100');
  });

  it('does nothing without a qualifying real sample', () => {
    const withNull = diagnoseAndNudge(stats, { tightness: 1.1 }, null, 0);
    const withSmall = diagnoseAndNudge(stats, { tightness: 1.1 }, -40, 200);
    expect(withNull.reasons.join(' ')).not.toContain('real bb100');
    expect(withSmall.reasons.join(' ')).not.toContain('real bb100');
  });

  it('a winning real sample never triggers the regression', () => {
    const { reasons } = diagnoseAndNudge(stats, { tightness: 1.1 }, 12, 5000);
    expect(reasons.join(' ')).not.toContain('real bb100');
  });
});
