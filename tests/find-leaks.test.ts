/**
 * findLeaks — the coaching layer.
 *
 * The failure mode this suite guards is not a crash. It is a stats page that
 * confidently tells somebody to change how they play on the evidence of eighty
 * hands, or that names a "leak" which is actually correct strategy. Every rule
 * has a minimum sample, and every minimum is pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  findLeaks,
  LEAK_MIN_HANDS,
  type LeakOverall,
  type LeakPosition,
} from '../src/components/stats/findLeaks';

/** A solid, unremarkable winning player. Should trip nothing. */
const SOLID: LeakOverall = {
  total_hands: 20000,
  cash_hands: 20000,
  vpip: 0.23,
  pfr: 0.19,
  three_bet_percent: 0.07,
  fold_to_three_bet: 0.55,
  cbet_flop: 0.62,
  wtsd: 0.27,
  aggression_factor: 2.4,
  showdowns_total: 1200,
  showdowns_won: 640,
  bb_per_100: 4.2,
};

const pos = (position: string, hands: number, vpipPct: number, bb100 = 0): LeakPosition => ({
  position,
  hands_played: hands,
  vpip_count: Math.round((vpipPct / 100) * hands),
  pfr_count: Math.round((vpipPct / 100) * hands * 0.8),
  three_bet_count: Math.round(hands * 0.02),
  hands_won: Math.round(hands * 0.2),
  total_profit: 0,
  bb100,
});

/** Correctly shaped positional play: tight UTG, wide BTN. */
const GOOD_POSITIONS: LeakPosition[] = [
  pos('UTG', 3000, 15),
  pos('MP', 3000, 18),
  pos('CO', 3000, 26),
  pos('BTN', 3000, 38),
  pos('SB', 3000, 22, -12),
  pos('BB', 3000, 40, -18),
];

describe('sample-size discipline', () => {
  it('says nothing at all below the minimum', () => {
    const r = findLeaks({ ...SOLID, total_hands: 80, vpip: 0.62, pfr: 0.02 }, GOOD_POSITIONS);
    expect(r.analysed).toBe(false);
    expect(r.leaks).toHaveLength(0);
  });

  it('reports how many more hands are needed', () => {
    const r = findLeaks({ ...SOLID, total_hands: 200 }, GOOD_POSITIONS);
    expect(r.handsShort).toBe(LEAK_MIN_HANDS - 200);
  });

  it('handles missing data without throwing', () => {
    expect(findLeaks(null, null).analysed).toBe(false);
    expect(findLeaks(undefined, undefined).leaks).toEqual([]);
  });

  it('analyses once the minimum is met', () => {
    expect(findLeaks(SOLID, GOOD_POSITIONS).analysed).toBe(true);
  });
});

describe('a solid player is told nothing is wrong', () => {
  it('finds no leaks in a well-shaped game', () => {
    const { leaks } = findLeaks(SOLID, GOOD_POSITIONS);
    expect(leaks).toHaveLength(0);
  });

  it('does not invent a leak from the blinds losing money', () => {
    // Losing from the blinds is structural, not a leak. -12 and -18 bb/100 are
    // normal and must not trip the bleeding-position rule.
    const { leaks } = findLeaks(SOLID, GOOD_POSITIONS);
    expect(leaks.find((l) => l.id.startsWith('position_losing_'))).toBeUndefined();
  });
});

describe('positional leaks', () => {
  it('catches position played backwards', () => {
    const inverted = [pos('UTG', 2000, 30), pos('BTN', 2000, 22)];
    const { leaks } = findLeaks(SOLID, inverted);
    const l = leaks.find((x) => x.id === 'position_inverted')!;
    expect(l).toBeDefined();
    expect(l.severity).toBe('high');
    expect(l.evidence).toContain('30.0%');
    expect(l.evidence).toContain('22.0%');
  });

  it('catches a range that barely changes with position', () => {
    const flat = [pos('UTG', 2000, 24), pos('BTN', 2000, 28)];
    const { leaks } = findLeaks(SOLID, flat);
    expect(leaks.find((x) => x.id === 'position_flat')).toBeDefined();
  });

  it('stays silent on positional shape when either position is thin', () => {
    const thin = [pos('UTG', 40, 40), pos('BTN', 30, 10)];
    const { leaks } = findLeaks(SOLID, thin);
    expect(leaks.find((x) => x.id === 'position_inverted')).toBeUndefined();
    expect(leaks.find((x) => x.id === 'position_flat')).toBeUndefined();
  });

  it('reports at most one bleeding position, the worst', () => {
    const bleeding = [...GOOD_POSITIONS, pos('UTG', 900, 15, -80), pos('MP', 900, 18, -40)];
    const { leaks } = findLeaks(SOLID, bleeding);
    const found = leaks.filter((l) => l.id.startsWith('position_losing_'));
    expect(found).toHaveLength(1);
    expect(found[0].evidence).toContain('-80');
  });
});

describe('preflop leaks', () => {
  it('catches calling far more than raising', () => {
    const { leaks } = findLeaks({ ...SOLID, vpip: 0.42, pfr: 0.09 }, GOOD_POSITIONS);
    expect(leaks.find((l) => l.id === 'passive_preflop')?.severity).toBe('high');
  });

  it('catches playing too many hands', () => {
    const { leaks } = findLeaks({ ...SOLID, vpip: 0.44, pfr: 0.34 }, GOOD_POSITIONS);
    expect(leaks.find((l) => l.id === 'too_loose')).toBeDefined();
  });

  it('catches playing too few', () => {
    const { leaks } = findLeaks({ ...SOLID, vpip: 0.1, pfr: 0.08 }, GOOD_POSITIONS);
    expect(leaks.find((l) => l.id === 'too_tight')).toBeDefined();
  });

  it('never reports both too loose and too tight', () => {
    for (const v of [0.05, 0.14, 0.23, 0.35, 0.6]) {
      const { leaks } = findLeaks({ ...SOLID, vpip: v, pfr: v * 0.8 }, GOOD_POSITIONS);
      const ids = leaks.map((l) => l.id);
      expect(ids.includes('too_loose') && ids.includes('too_tight')).toBe(false);
    }
  });
});

describe('fold to 3-bet', () => {
  it('catches folding too often', () => {
    const { leaks } = findLeaks({ ...SOLID, fold_to_three_bet: 0.78 }, GOOD_POSITIONS);
    const l = leaks.find((x) => x.id === 'folds_to_3bet')!;
    expect(l.severity).toBe('high');
    expect(l.action).toMatch(/any two cards/i);
  });

  it('catches defending far too wide', () => {
    const { leaks } = findLeaks({ ...SOLID, fold_to_three_bet: 0.18 }, GOOD_POSITIONS);
    expect(leaks.find((x) => x.id === 'calls_3bets_too_wide')).toBeDefined();
  });

  it('stays silent for a player who barely raises preflop', () => {
    // With PFR that low they hardly ever face a 3-bet, so the rate is noise.
    const { leaks } = findLeaks({ ...SOLID, pfr: 0.03, fold_to_three_bet: 0.9 }, GOOD_POSITIONS);
    expect(leaks.find((x) => x.id === 'folds_to_3bet')).toBeUndefined();
  });

  it('treats a zero fold-to-3bet as no data rather than as a leak', () => {
    const { leaks } = findLeaks({ ...SOLID, fold_to_three_bet: 0 }, GOOD_POSITIONS);
    expect(leaks.find((x) => x.id === 'calls_3bets_too_wide')).toBeUndefined();
  });
});

describe('postflop leaks', () => {
  it('catches overall passivity', () => {
    const { leaks } = findLeaks({ ...SOLID, aggression_factor: 0.6 }, GOOD_POSITIONS);
    expect(leaks.find((x) => x.id === 'passive_postflop')?.severity).toBe('high');
  });

  it('catches c-betting every flop', () => {
    const { leaks } = findLeaks({ ...SOLID, cbet_flop: 0.93 }, GOOD_POSITIONS);
    expect(leaks.find((x) => x.id === 'cbet_too_high')).toBeDefined();
  });

  it('catches giving up on the flop', () => {
    const { leaks } = findLeaks({ ...SOLID, cbet_flop: 0.2 }, GOOD_POSITIONS);
    expect(leaks.find((x) => x.id === 'cbet_too_low')).toBeDefined();
  });

  it('catches paying off too often', () => {
    // Updated 2026-08-21: the rule no longer reads `overall.wtsd`, which is
    // showdowns over hands DEALT and therefore never crossed the industry
    // thresholds it was written against. It now measures showdowns over hands
    // voluntarily PLAYED, which is what the copy claims and what a player
    // actually controls: 2,200 showdowns over 0.2 x 20,000 = 4,000 played.
    const { leaks } = findLeaks(
      { ...SOLID, vpip: 0.2, total_hands: 20000, showdowns_total: 2200, showdowns_won: 1200 },
      GOOD_POSITIONS
    );
    expect(leaks.find((x) => x.id === 'wtsd_high')).toBeDefined();
  });

  it('catches arriving at showdown behind', () => {
    const { leaks } = findLeaks(
      { ...SOLID, wtsd: 0.33, showdowns_total: 800, showdowns_won: 320 },
      GOOD_POSITIONS
    );
    expect(leaks.find((x) => x.id === 'losing_showdowns')).toBeDefined();
  });

  it('stays silent on showdowns with too few of them', () => {
    const { leaks } = findLeaks(
      { ...SOLID, wtsd: 0.45, showdowns_total: 20, showdowns_won: 4 },
      GOOD_POSITIONS
    );
    expect(leaks.find((x) => x.id === 'wtsd_high')).toBeUndefined();
    expect(leaks.find((x) => x.id === 'losing_showdowns')).toBeUndefined();
  });
});

describe('output contract', () => {
  const AWFUL: LeakOverall = {
    ...SOLID,
    vpip: 0.62,
    pfr: 0.04,
    fold_to_three_bet: 0.92,
    cbet_flop: 0.95,
    wtsd: 0.48,
    aggression_factor: 0.3,
    showdowns_total: 900,
    showdowns_won: 300,
  };

  it('never returns more than five findings', () => {
    const { leaks } = findLeaks(AWFUL, [pos('UTG', 2000, 60), pos('BTN', 2000, 30)]);
    expect(leaks.length).toBeLessThanOrEqual(5);
  });

  it('ranks the costly ones first', () => {
    const { leaks } = findLeaks(AWFUL, [pos('UTG', 2000, 60), pos('BTN', 2000, 30)]);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < leaks.length; i++) {
      expect(rank[leaks[i].severity]).toBeGreaterThanOrEqual(rank[leaks[i - 1].severity]);
    }
  });

  it('gives every finding a title, evidence and an action', () => {
    const { leaks } = findLeaks(AWFUL, [pos('UTG', 2000, 60), pos('BTN', 2000, 30)]);
    expect(leaks.length).toBeGreaterThan(0);
    for (const l of leaks) {
      expect(l.title.length).toBeGreaterThan(8);
      expect(l.evidence.length).toBeGreaterThan(8);
      expect(l.action.length).toBeGreaterThan(20);
      expect(l.id).toBeTruthy();
    }
  });

  it('produces unique ids so React keys cannot collide', () => {
    const { leaks } = findLeaks(AWFUL, [pos('UTG', 2000, 60), pos('BTN', 2000, 30)]);
    expect(new Set(leaks.map((l) => l.id)).size).toBe(leaks.length);
  });
});
