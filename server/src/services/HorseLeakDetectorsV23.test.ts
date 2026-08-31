/**
 * V23 DETECTOR COVERAGE (2026-08-28) — the audit only fixes what it can see,
 * and 4,549 big losses a day carried no tag. New reads:
 *   - big_bet_fold split: big_fold_river vs big_fold_early, plus the
 *     bet_fold_line shape (bet the street it folded on);
 *   - preflop entry: limped_pot_bloat and coldcall_stackoff;
 *   - river_raise_paidoff: bet the river, then called a raise on it.
 * All from the hero's own action stream — detectLeaks sees nothing else.
 */

import { describe, it, expect } from 'vitest';
import { detectLeaks } from './HorseHandReview.js';
import type { Card } from '../types.js';

const c = (spec: string): Card => {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
};

function base(overrides: Partial<Parameters<typeof detectLeaks>[0]> = {}) {
  return {
    netBB: -60,
    invested: 3000,
    bigBlind: 50,
    variant: 'nlh',
    holeCards: [c('Ah'), c('Kd')],
    board: [c('2c'), c('7d'), c('9s'), c('Jh'), c('4c')],
    heroActions: [] as Array<{ action: string; stage: string; amount?: number }>,
    wentToShowdown: false,
    ...overrides,
  };
}

describe('V23 big_bet_fold split', () => {
  it('a river fold after building the pot reads big_fold_river', () => {
    const tags = detectLeaks(
      base({
        heroActions: [
          { action: 'call', stage: 'preflop', amount: 150 },
          { action: 'call', stage: 'flop', amount: 500 },
          { action: 'call', stage: 'turn', amount: 1200 },
          { action: 'fold', stage: 'river' },
        ],
      })
    );
    expect(tags).toContain('big_bet_fold');
    expect(tags).toContain('big_fold_river');
    expect(tags).not.toContain('big_fold_early');
    expect(tags).not.toContain('bet_fold_line');
  });

  it('a turn surrender reads big_fold_early', () => {
    const tags = detectLeaks(
      base({
        heroActions: [
          { action: 'call', stage: 'preflop', amount: 150 },
          { action: 'call', stage: 'flop', amount: 900 },
          { action: 'fold', stage: 'turn' },
        ],
      })
    );
    expect(tags).toContain('big_fold_early');
    expect(tags).not.toContain('big_fold_river');
  });

  it('betting the street it folded on reads bet_fold_line', () => {
    const tags = detectLeaks(
      base({
        heroActions: [
          { action: 'call', stage: 'preflop', amount: 150 },
          { action: 'bet', stage: 'turn', amount: 1400 },
          { action: 'fold', stage: 'turn' },
        ],
      })
    );
    expect(tags).toContain('bet_fold_line');
  });

  it('a small fold carries none of the fold tags', () => {
    const tags = detectLeaks(
      base({
        invested: 200, // 4bb
        heroActions: [
          { action: 'call', stage: 'preflop', amount: 150 },
          { action: 'fold', stage: 'flop' },
        ],
      })
    );
    expect(tags).not.toContain('big_bet_fold');
    expect(tags).not.toContain('big_fold_early');
  });
});

describe('V23 preflop-entry detectors', () => {
  it('a limped entry that lost a stack reads limped_pot_bloat', () => {
    const tags = detectLeaks(
      base({
        invested: 3000, // 60bb
        wentToShowdown: true,
        heroActions: [
          { action: 'call', stage: 'preflop', amount: 50 }, // one bb — a limp
          { action: 'call', stage: 'flop', amount: 800 },
          { action: 'call', stage: 'turn', amount: 2150 },
        ],
      })
    );
    expect(tags).toContain('limped_pot_bloat');
    expect(tags).not.toContain('coldcall_stackoff');
  });

  it('cold-calling a raise into a stack-off reads coldcall_stackoff', () => {
    const tags = detectLeaks(
      base({
        invested: 3000,
        wentToShowdown: true,
        heroActions: [
          { action: 'call', stage: 'preflop', amount: 450 }, // 9bb — a raise called
          { action: 'call', stage: 'flop', amount: 1000 },
          { action: 'call', stage: 'turn', amount: 1550 },
        ],
      })
    );
    expect(tags).toContain('coldcall_stackoff');
    expect(tags).not.toContain('limped_pot_bloat');
  });

  it('taking the preflop initiative excludes both entry tags', () => {
    const tags = detectLeaks(
      base({
        invested: 3000,
        wentToShowdown: true,
        heroActions: [
          { action: 'raise', stage: 'preflop', amount: 450 },
          { action: 'call', stage: 'flop', amount: 2550 },
        ],
      })
    );
    expect(tags).not.toContain('limped_pot_bloat');
    expect(tags).not.toContain('coldcall_stackoff');
  });
});

describe('V23 river_raise_paidoff', () => {
  it('bet the river, called the raise, lost - tagged', () => {
    const tags = detectLeaks(
      base({
        wentToShowdown: true,
        heroActions: [
          { action: 'call', stage: 'preflop', amount: 150 },
          { action: 'bet', stage: 'river', amount: 1000 },
          { action: 'call', stage: 'river', amount: 1850 },
        ],
      })
    );
    expect(tags).toContain('river_raise_paidoff');
    expect(tags).toContain('river_aggr_lost');
    expect(tags).not.toContain('river_raise_war'); // one aggressive act only
  });

  it('a plain river value bet that lost is NOT a paid-off raise', () => {
    const tags = detectLeaks(
      base({
        wentToShowdown: true,
        heroActions: [
          { action: 'call', stage: 'preflop', amount: 150 },
          { action: 'bet', stage: 'river', amount: 1000 },
        ],
      })
    );
    expect(tags).toContain('river_aggr_lost');
    expect(tags).not.toContain('river_raise_paidoff');
  });

  it('wins carry no tags at all', () => {
    const tags = detectLeaks(
      base({
        netBB: 80,
        heroActions: [
          { action: 'bet', stage: 'river', amount: 1000 },
          { action: 'call', stage: 'river', amount: 1850 },
        ],
      })
    );
    expect(tags).toEqual([]);
  });
});
