import { describe, expect, it } from 'vitest';
import { parseClubFinancialsPayload } from '../../src/utils/clubFinancialsPayload';

const request = { start: '2026-10-02', end: '2026-10-03' };

const payload = () => ({
  range: {
    start: '2026-10-02',
    end: '2026-10-03',
    days: 2,
    first_day: '2026-09-01',
    series_from: '2026-10-02',
  },
  union_id: 'union-a',
  totals: {
    raked_hands: 5,
    gross_rake: 30.25,
    bbj_drop: 1.25,
    net_rake: 29,
    pot_volume: 300.1,
    tournament_fees: 5,
    rakeback_paid: 3,
    rakeback_rows: 2,
    agent_commissions: 1.5,
    union_fee: 0.75,
    union_statements: 1,
    union_squareup: -7,
    net_revenue: 28.75,
  },
  daily: [
    {
      d: '2026-10-02',
      raked_hands: 2,
      gross_rake: 10.25,
      bbj_drop: 0.25,
      pot_volume: 100.1,
      tournament_fees: 2,
      rakeback_paid: 1,
      agent_commissions: 0.5,
      union_fee: 0.25,
    },
    {
      d: '2026-10-03',
      raked_hands: 3,
      gross_rake: 20,
      bbj_drop: 1,
      pot_volume: 200,
      tournament_fees: 3,
      rakeback_paid: 2,
      agent_commissions: 1,
      union_fee: 0.5,
    },
  ],
  by_table: [
    {
      table_id: 'table-a',
      name: 'Table One',
      status: 'active',
      stakes: '1/2',
      variant: 'NLH',
      raked_hands: 5,
      rake: 30.25,
      players: 6,
      table_net: -12.5,
    },
  ],
  recent: [
    {
      id: 'rake-a',
      hand_id: 'hand-a',
      global_hand_id: 42,
      table_name: 'Table One',
      kind: 'cash_rake',
      rake_amount: 2.25,
      bbj_contribution: 0.25,
      pot_size: 50,
      num_players: 6,
      created_at: '2026-10-03T12:00:00Z',
    },
  ],
  data_updated_at: '2026-10-03T12:01:00Z',
  club_table_daily_updated_at: '2026-10-03T12:02:00Z',
  generated_at: '2026-10-03T12:03:00Z',
});

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

describe('parseClubFinancialsPayload', () => {
  it('accepts a complete exact-cent report bound to the requested range', () => {
    expect(parseClubFinancialsPayload(payload(), request)).toMatchObject({
      range: { start: '2026-10-02', end: '2026-10-03', days: 2 },
      totals: { net_rake: 29, net_revenue: 28.75 },
      daily: [{ d: '2026-10-02' }, { d: '2026-10-03' }],
    });
  });

  it('accepts the RPC start clamp when the club first appears after the requested start', () => {
    const value = payload();
    value.range.first_day = '2026-10-02';
    expect(
      parseClubFinancialsPayload(value, { start: '2026-01-01', end: request.end }).range
    ).toEqual(value.range);
  });

  it('allows only the derived per-day rounding bound for contribution-split cash rake', () => {
    const independentlyRounded = payload();
    independentlyRounded.daily[0].gross_rake = 10.24;
    expect(parseClubFinancialsPayload(independentlyRounded, request).totals.gross_rake).toBe(30.25);

    const outsideBound = payload();
    outsideBound.daily[0].gross_rake = 10.23;
    expect(() => parseClubFinancialsPayload(outsideBound, request)).toThrow(
      /daily gross rake reconciliation/
    );
  });

  it.each([
    ['another end date', (value: ReturnType<typeof payload>) => (value.range.end = '2026-10-04')],
    [
      'an unclamped start',
      (value: ReturnType<typeof payload>) => (value.range.start = '2026-10-01'),
    ],
    ['the wrong day count', (value: ReturnType<typeof payload>) => (value.range.days = 3)],
    ['a missing daily row', (value: ReturnType<typeof payload>) => value.daily.pop()],
    ['a daily gap', (value: ReturnType<typeof payload>) => (value.daily[1].d = '2026-10-04')],
    [
      'a fractional hand count',
      (value: ReturnType<typeof payload>) => (value.daily[0].raked_hands = 1.5),
    ],
    [
      'a non-finite amount',
      (value: ReturnType<typeof payload>) => (value.totals.gross_rake = Number.NaN),
    ],
    [
      'a sub-cent amount',
      (value: ReturnType<typeof payload>) => (value.daily[0].gross_rake = 10.251),
    ],
    ['a false net rake', (value: ReturnType<typeof payload>) => (value.totals.net_rake = 28)],
    ['a false net revenue', (value: ReturnType<typeof payload>) => (value.totals.net_revenue = 1)],
    [
      'a daily-total mismatch',
      (value: ReturnType<typeof payload>) => (value.daily[0].pot_volume = 99),
    ],
  ])('rejects %s', (_label, mutate) => {
    const value = payload();
    mutate(value);
    expect(() => parseClubFinancialsPayload(value, request)).toThrow(/Club financials/);
  });

  it('does not reconcile full-range totals against the intentionally capped 92-day chart', () => {
    const value = payload();
    const end = new Date('2026-10-03T00:00:00Z');
    const seriesStart = new Date(end);
    seriesStart.setUTCDate(seriesStart.getUTCDate() - 91);
    value.range = {
      start: '2026-01-01',
      end: '2026-10-03',
      days: 276,
      first_day: '2026-01-01',
      series_from: isoDay(seriesStart),
    };
    value.daily = Array.from({ length: 92 }, (_, index) => {
      const d = new Date(seriesStart);
      d.setUTCDate(d.getUTCDate() + index);
      return {
        d: isoDay(d),
        raked_hands: 0,
        gross_rake: 0,
        bbj_drop: 0,
        pot_volume: 0,
        tournament_fees: 0,
        rakeback_paid: 0,
        agent_commissions: 0,
        union_fee: 0,
      };
    });

    expect(
      parseClubFinancialsPayload(value, { start: '2026-01-01', end: '2026-10-03' }).totals
        .gross_rake
    ).toBe(30.25);
  });

  it('rejects duplicate or out-of-order identity rows and recent rows outside the range', () => {
    const duplicateTable = payload();
    duplicateTable.by_table.push({ ...duplicateTable.by_table[0] });
    expect(() => parseClubFinancialsPayload(duplicateTable, request)).toThrow(/duplicate table/);

    const outsideRange = payload();
    outsideRange.recent[0].created_at = '2026-10-04T00:00:00Z';
    expect(() => parseClubFinancialsPayload(outsideRange, request)).toThrow(/order or range/);
  });
});
