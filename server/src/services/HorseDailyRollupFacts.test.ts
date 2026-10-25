import { describe, expect, it } from 'vitest';
import { buildHorseDailyRollupFacts } from './HorseDailyRollupFacts.js';
import type { HorseReviewInput } from './HorseHandReview.js';

const input = (over: Partial<HorseReviewInput> = {}): HorseReviewInput => ({
  handId: 'hand',
  tableId: 'table',
  playedAt: '2026-10-24T23:59:59.999Z',
  gameVariant: 'plo4',
  bigBlind: 2,
  holeCardsAll: new Map([
    ['a', { seat: 1, cards: [] }],
    ['b', { seat: 2, cards: [] }],
    ['human', { seat: 3, cards: [] }],
  ]),
  roster: [
    { userId: 'a', isHorse: true },
    { userId: 'b', isHorse: true },
    { userId: 'undealt', isHorse: true },
    { userId: 'human', isHorse: false },
  ],
  contributions: new Map([
    ['a', 2],
    ['human', 2],
  ]),
  winners: [{ userId: 'a', amount: 3.8 }],
  rakeAmount: 0.1,
  bbjAmount: 0.1,
  actions: [],
  ...over,
});

describe('one accepted hand supplies both horse daily counts', () => {
  it('counts dealt zero-action and zero-cost hands in both denominators', () => {
    const d = buildHorseDailyRollupFacts(input());
    expect(d.nets.map((x) => [x.horse_user_id, x.hands])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
    expect(d.play.map((x) => [x.horse_user_id, x.hands])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
    expect(d.nets[1].net_bb).toBe(0);
    expect(d.nets[0]).toMatchObject({
      rake_bb: 0.025,
      bbj_bb: 0.025,
      day: '2026-10-24',
      format: 'cash',
    });
    expect(d.nets[0].net_bb).toBeCloseTo(0.9, 12);
    expect(d.play[0]).toMatchObject({ vpip: 0, pfr: 0, post_aggr: 0, post_passive: 0 });
  });
  it('uses chip movement only when the deal is unavailable', () => {
    const d = buildHorseDailyRollupFacts(input({ holeCardsAll: new Map() }));
    expect(d.nets.map((x) => x.horse_user_id)).toEqual(['a']);
    expect(d.play.map((x) => x.horse_user_id)).toEqual(['a']);
  });
  it('does not admit an undealt action actor', () => {
    const d = buildHorseDailyRollupFacts(
      input({
        actions: [{ seat: 4, userId: 'undealt', stage: 'preflop', action: 'call', amount: 2 }],
      })
    );
    expect(d.play.map((x) => x.horse_user_id)).toEqual(['a', 'b']);
  });
  it.each(['cash', 'tournament', 'hu_cash', 'lightning_2bb'])(
    'keeps the %s bucket paired',
    (format) => {
      const d = buildHorseDailyRollupFacts(input({ format, vpipFloor: 40 }));
      expect(d.nets.every((x) => x.format === format)).toBe(true);
      expect(d.play.every((x) => x.format === format && x.floored)).toBe(true);
    }
  );
  it('uses exact settlement investment, independent of the action reconstruction', () => {
    const d = buildHorseDailyRollupFacts(
      input({ actions: [{ seat: 1, userId: 'a', stage: 'river', action: 'raise', amount: 999 }] })
    );
    expect(d.nets[0].net_bb).toBeCloseTo(0.9, 12);
    expect(d.play[0].post_aggr).toBe(1);
  });
});
