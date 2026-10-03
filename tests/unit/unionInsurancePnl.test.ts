import { describe, expect, it } from 'vitest';
import { parseUnionInsurancePnl } from '../../src/utils/unionInsurancePnl';

function validPayload() {
  const daily = Array.from({ length: 14 }, (_, index) => {
    const date = new Date('2026-09-20T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() + index);
    return {
      d: date.toISOString().slice(0, 10),
      contracts: 0,
      premiums: 0,
      payouts: 0,
      net: 0,
      overlay: 0,
    };
  });
  daily[0] = {
    ...daily[0],
    contracts: 2,
    premiums: 30.25,
    payouts: 10,
    net: 20.25,
    overlay: 50.5,
  };
  daily[13] = {
    ...daily[13],
    contracts: 1,
    premiums: 9.75,
    payouts: 4,
    net: 5.75,
  };

  return {
    union_id: 'union-a',
    range_days: 14,
    totals: { contracts: 3, premiums: 40, payouts: 14, net: 26 },
    overlay: { events: 1, funded: 50.5 },
    daily,
    by_club: [
      {
        club_id: 'club-a',
        club_name: 'alpha club',
        contracts: 2,
        premiums: 30.25,
        payouts: 10,
        net: 20.25,
      },
      {
        club_id: 'club-b',
        club_name: 'beta club',
        contracts: 1,
        premiums: 9.75,
        payouts: 4,
        net: 5.75,
      },
    ],
    generated_at: '2026-10-03T12:00:00.000Z',
  };
}

describe('parseUnionInsurancePnl', () => {
  it('accepts the exact 14-day SQL payload and preserves cent values', () => {
    const parsed = parseUnionInsurancePnl(validPayload(), 'union-a', 14);

    expect(parsed).toMatchObject({
      union_id: 'union-a',
      range_days: 14,
      totals: { contracts: 3, premiums: 40, payouts: 14, net: 26 },
      overlay: { events: 1, funded: 50.5 },
      generated_at: '2026-10-03T12:00:00.000Z',
    });
    expect(parsed.daily).toHaveLength(14);
    expect(parsed.daily[0]).toMatchObject({
      d: '2026-09-20',
      contracts: 2,
      premiums: 30.25,
      payouts: 10,
      net: 20.25,
      overlay: 50.5,
    });
    expect(parsed.by_club.map((row) => row.club_id)).toEqual(['club-a', 'club-b']);
  });

  it('rejects the wrong union identity or range', () => {
    expect(() => parseUnionInsurancePnl(validPayload(), 'union-b', 14)).toThrow(
      'identity does not match'
    );
    expect(() => parseUnionInsurancePnl(validPayload(), 'union-a', 7)).toThrow(
      'range does not match'
    );
  });

  it('rejects fractional counts and non-cent money', () => {
    const fractionalCount = validPayload();
    fractionalCount.totals.contracts = 2.5;
    expect(() => parseUnionInsurancePnl(fractionalCount, 'union-a')).toThrow(
      'contract count is invalid'
    );

    const fractionalCent = validPayload();
    fractionalCent.totals.premiums = 40.001;
    expect(() => parseUnionInsurancePnl(fractionalCent, 'union-a')).toThrow(
      'not an exact chip-cent amount'
    );
  });

  it('rejects every local premiums-minus-payouts net mismatch', () => {
    const totals = validPayload();
    totals.totals.net = 25;
    expect(() => parseUnionInsurancePnl(totals, 'union-a')).toThrow(
      'Union insurance totals net does not reconcile'
    );

    const day = validPayload();
    day.daily[0].net = 20;
    expect(() => parseUnionInsurancePnl(day, 'union-a')).toThrow(
      'Union insurance day 1 net does not reconcile'
    );

    const club = validPayload();
    club.by_club[0].net = 20;
    expect(() => parseUnionInsurancePnl(club, 'union-a')).toThrow(
      'Union insurance club 1 net does not reconcile'
    );
  });

  it('rejects daily, by-club, and overlay aggregate mismatches', () => {
    const daily = validPayload();
    daily.daily[0].contracts = 3;
    expect(() => parseUnionInsurancePnl(daily, 'union-a')).toThrow(
      'daily totals does not reconcile'
    );

    const clubs = validPayload();
    clubs.by_club[1].contracts = 2;
    expect(() => parseUnionInsurancePnl(clubs, 'union-a')).toThrow(
      'club totals does not reconcile'
    );

    const overlay = validPayload();
    overlay.daily[0].overlay = 50.49;
    expect(() => parseUnionInsurancePnl(overlay, 'union-a')).toThrow(
      'overlay total does not reconcile'
    );
  });

  it('rejects incomplete or nonconsecutive daily coverage', () => {
    const incomplete = validPayload();
    incomplete.daily.pop();
    expect(() => parseUnionInsurancePnl(incomplete, 'union-a')).toThrow('daily series is invalid');

    const duplicate = validPayload();
    duplicate.daily[1].d = duplicate.daily[0].d;
    expect(() => parseUnionInsurancePnl(duplicate, 'union-a')).toThrow(
      'daily series is not consecutive'
    );
  });

  it('rejects duplicate or SQL-impossible by-club ordering', () => {
    const duplicate = validPayload();
    duplicate.by_club[1].club_id = duplicate.by_club[0].club_id;
    expect(() => parseUnionInsurancePnl(duplicate, 'union-a')).toThrow('club series is duplicated');

    const ordering = validPayload();
    ordering.by_club.reverse();
    expect(() => parseUnionInsurancePnl(ordering, 'union-a')).toThrow(
      'club series is out of order'
    );
  });

  it('rejects a malformed generation time or a series ending on another UTC date', () => {
    const malformed = validPayload();
    malformed.generated_at = 'not-a-time';
    expect(() => parseUnionInsurancePnl(malformed, 'union-a')).toThrow(
      'generation time is invalid'
    );

    const stale = validPayload();
    stale.generated_at = '2026-10-04T00:00:00.000Z';
    expect(() => parseUnionInsurancePnl(stale, 'union-a')).toThrow(
      'does not reach its generation date'
    );
  });
});
