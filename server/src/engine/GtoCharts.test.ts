/**
 * V27 — THE SOLVER CHARTS REACH THE BRAIN (Dan 2026-08-29).
 *
 * "MAKE SURE THE HORSES HAVE ACCESS TO THE SOLVER DATABASE ... THEY'RE NOT
 *  JUST GUESSING, THEY HAVE SPECIFIC GTO RENDERED PLAYS."
 *
 * The chart data shape these tests encode was read from PRODUCTION
 * (memory_charts_gold, 2026-08-29): 'Cash'/'Tournament', depths 2..20 and 25,
 * fold_to_hero charts for UTG/MP/CO/BTN/SB, sb_push for BB, matrices of ~70
 * hands where AN ABSENT HAND IS A FOLD.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setGtoCharts,
  gtoChartCount,
  _clearGtoCharts,
  handClass,
  snapDepth,
  gtoOpenJam,
  gtoBbVsSbJam,
  GTO_OPEN_JAM_MAX_BB,
} from './GtoCharts.js';
import { HorseLogic } from './HorseLogic.js';
import type { Card, SeatPlayer } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

function chart(
  game: string,
  pos: string,
  depth: number,
  villain: string,
  matrix: Record<string, Record<string, number>>
) {
  return {
    game_type: game,
    hero_position: pos,
    stack_depth: depth,
    villain_action: villain,
    hand_matrix: matrix,
  };
}

beforeEach(() => _clearGtoCharts());

describe('handClass - hole cards to the 169-class label the charts key on', () => {
  it('pairs, suited, offsuit - higher rank always first', () => {
    expect(handClass(c('A', 'hearts'), c('A', 'clubs'))).toBe('AA');
    expect(handClass(c('K', 'hearts'), c('A', 'hearts'))).toBe('AKs');
    expect(handClass(c('A', 'hearts'), c('K', 'clubs'))).toBe('AKo');
    expect(handClass(c('2', 'spades'), c('7', 'clubs'))).toBe('72o');
    expect(handClass(c('9', 'diamonds'), c('T', 'diamonds'))).toBe('T9s');
  });

  it('never fabricates a class from a broken card', () => {
    expect(handClass(c('', 'hearts'), c('A', 'clubs'))).toBe(null);
    expect(handClass(c('X', 'hearts'), c('A', 'clubs'))).toBe(null);
  });
});

describe('snapDepth - stacks land on charts that exist', () => {
  it('snaps to the real ladder, including the 20->25 gap', () => {
    expect(snapDepth(11.6)).toBe(12);
    expect(snapDepth(2.2)).toBe(2);
    expect(snapDepth(21)).toBe(20);
    expect(snapDepth(23)).toBe(25);
    expect(snapDepth(24)).toBe(25);
  });
});

describe('gtoOpenJam - folded to hero, the chart decides', () => {
  beforeEach(() => {
    setGtoCharts([
      chart('Cash', 'BTN', 10, 'fold_to_hero', {
        AA: { push: 1, fold: 0 },
        A5s: { push: 0.964, fold: 0.036 },
        KTo: { push: 0.084, fold: 0.916 },
      }),
    ]);
  });

  it('a charted hand returns the solver frequency, not a guess', () => {
    const advice = gtoOpenJam({ isTournament: false, position: 'BTN', stackBB: 10, hand: 'A5s' });
    expect(advice).toEqual({ action: 'push', freq: 0.964, chart: 'Cash|fold_to_hero|BTN|10' });
  });

  it('AN ABSENT HAND IS A FOLD - 72o is not in any chart because 72o folds', () => {
    const advice = gtoOpenJam({ isTournament: false, position: 'BTN', stackBB: 10, hand: '72o' });
    expect(advice).toEqual({ action: 'fold', freq: 1, chart: 'Cash|fold_to_hero|BTN|10' });
  });

  it('a mixed hand reports the majority action with its frequency', () => {
    const advice = gtoOpenJam({ isTournament: false, position: 'BTN', stackBB: 10, hand: 'KTo' });
    expect(advice?.action).toBe('fold');
    expect(advice?.freq).toBeCloseTo(0.916);
  });

  it('out of the push/fold zone the chart stays silent - a 25bb open is not jam-or-fold', () => {
    expect(
      gtoOpenJam({
        isTournament: false,
        position: 'BTN',
        stackBB: GTO_OPEN_JAM_MAX_BB + 1,
        hand: 'AA',
      })
    ).toBe(null);
  });

  it('tournament and cash are different charts, never substituted', () => {
    expect(gtoOpenJam({ isTournament: true, position: 'BTN', stackBB: 10, hand: 'AA' })).toBe(null);
  });

  it('an empty store answers null - the heuristics decide, the brain is never lobotomized', () => {
    _clearGtoCharts();
    expect(gtoChartCount()).toBe(0);
    expect(gtoOpenJam({ isTournament: false, position: 'BTN', stackBB: 10, hand: 'AA' })).toBe(
      null
    );
  });
});

describe('gtoBbVsSbJam - the BB call-off is charted to 25bb', () => {
  beforeEach(() => {
    setGtoCharts([
      chart('Tournament', 'BB', 10, 'sb_push', {
        AA: { call: 1, fold: 0 },
        K9s: { call: 1, fold: 0 },
        Q2o: { call: 0.12, fold: 0.88 },
      }),
    ]);
  });

  it('effective stack decides the chart: 25bb hero against an 8bb jam is a ~8-10bb decision', () => {
    const advice = gtoBbVsSbJam({ isTournament: true, effectiveBB: 9.8, hand: 'K9s' });
    expect(advice).toEqual({ action: 'call', freq: 1, chart: 'Tournament|sb_push|BB|10' });
  });

  it('junk calls at the solver frequency, not never and not always', () => {
    const advice = gtoBbVsSbJam({ isTournament: true, effectiveBB: 10, hand: 'Q2o' });
    expect(advice?.action).toBe('fold');
    expect(advice?.freq).toBeCloseTo(0.88);
  });
});

describe('the wiring - the brain actually plays the chart', () => {
  const mkPlayer = (over: Partial<SeatPlayer> = {}): SeatPlayer =>
    ({
      seat: 3,
      user_id: 'hero',
      stack: 20,
      bet: 0,
      is_folded: false,
      is_sitting_out: false,
      cards: [c('A', 'hearts'), c('A', 'clubs')],
      ...over,
    }) as unknown as SeatPlayer;

  const mkGs = (over: Record<string, unknown> = {}) => ({
    players: [
      mkPlayer(),
      { seat: 0, user_id: 'v1', stack: 200, bet: 1, is_folded: false, cards: [] },
      { seat: 1, user_id: 'v2', stack: 200, bet: 2, is_folded: false, cards: [] },
    ],
    communityCards: [],
    pot: 3,
    currentBet: 2,
    minRaise: 4,
    stage: 'preflop',
    gameVariant: 'nlh',
    bigBlind: 2,
    dealerSeat: 3,
    actionHistory: [],
    ...over,
  });

  it('a 10bb BTN with aces open-jams from the chart, deterministically', () => {
    setGtoCharts([chart('Cash', 'BTN', 10, 'fold_to_hero', { AA: { push: 1, fold: 0 } })]);
    // Hero on the button (seat === dealerSeat), 20 chips at bb 2 = 10bb.
    for (let i = 0; i < 20; i++) {
      const d = HorseLogic.decide(mkPlayer(), mkGs() as never, 'balanced');
      expect(d.action).toBe('all_in');
    }
  });

  it('a 10bb BTN with 72o folds from the chart - absent hand, pure fold', () => {
    setGtoCharts([chart('Cash', 'BTN', 10, 'fold_to_hero', { AA: { push: 1, fold: 0 } })]);
    for (let i = 0; i < 20; i++) {
      const d = HorseLogic.decide(
        mkPlayer({ cards: [c('7', 'hearts'), c('2', 'clubs')] }),
        mkGs() as never,
        'balanced'
      );
      expect(d.action).toBe('fold');
    }
  });

  /**
   * ABLATION EQUALITY. With no charts hydrated the layer must be invisible:
   * the same seed of inputs produces the same decisions as v27 disabled.
   * This is the pin that guarantees a loader failure cannot change poker.
   */
  it('empty store === layer off, decision for decision', () => {
    _clearGtoCharts();
    const hands: Array<[Card, Card]> = [
      [c('A', 'hearts'), c('A', 'clubs')],
      [c('7', 'hearts'), c('2', 'clubs')],
      [c('K', 'hearts'), c('T', 'clubs')],
      [c('9', 'diamonds'), c('8', 'diamonds')],
    ];
    for (const cards of hands) {
      const on = HorseLogic.decide(
        mkPlayer({ cards }),
        mkGs() as never,
        'balanced',
        {},
        {
          v27GtoCharts: true,
        }
      );
      const off = HorseLogic.decide(
        mkPlayer({ cards }),
        mkGs() as never,
        'balanced',
        {},
        {
          v27GtoCharts: false,
        }
      );
      expect(on.action).toBe(off.action);
    }
  });

  it('deep stacks never consult the chart - 100bb aces do not become an open jam', () => {
    setGtoCharts([
      chart('Cash', 'BTN', 10, 'fold_to_hero', { AA: { push: 1, fold: 0 } }),
      chart('Cash', 'BTN', 25, 'fold_to_hero', { AA: { push: 1, fold: 0 } }),
    ]);
    const d = HorseLogic.decide(mkPlayer({ stack: 200 }), mkGs() as never, 'balanced');
    expect(d.action).not.toBe('all_in');
  });

  it('the loader is wired at boot', async () => {
    const { readFileSync } = await import('node:fs');
    const idx = readFileSync(new URL('../index.ts', import.meta.url).pathname, 'utf8');
    expect(idx).toContain('startGtoChartLoader()');
  });
});
