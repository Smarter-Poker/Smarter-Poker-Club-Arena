import { it, expect } from 'vitest';
import {
  resolveDiamondCashJackpotSchedule as resolve,
  priceDiamondCashJackpotDrop as price,
} from './diamondCashJackpotSchedule.js';
import { snapshotDiamondCashFees, priceDiamondCashFees } from './diamondCashFeeSnapshot.js';
import type { EconomicsRow } from './diamondCashRakeSchedule.js';
const row = (name: string, value_text: string | null, value: unknown = null, scope = 'all') =>
  ({ id: 1, name, scope, value, value_text, recorded_at: '2026-10-12T00:00:00Z' }) as EconomicsRow;
const enabled = () => [
  row('bbj_enabled', 'yes'),
  row('mini_bbj_enabled', 'yes'),
  row('bbj_drop_per_hand', null, 3, 'bb:100'),
  row('bbj_min_pot', null, 1000, 'bb:100'),
  row('bbj_min_dealt_in', null, 3),
  row('mini_bbj_amount', null, 1500, 'bb:100'),
  row('mini_bbj_reserve_floor', null, 5000),
  row('bbj_excluded_games', 'plo6,short_deck'),
  row('bbj_qualifying_hand', 'nlh=AAAJJ'),
];
it('main switch must explicitly say yes/no, including rolling upgrades', () => {
  expect(() => resolve([], 100)).toThrow('unset:bbj_enabled');
  for (const word of ['', 'true', 'YES', 'unknown'])
    expect(() => resolve([row('bbj_enabled', word)], 100)).toThrow();
  expect(resolve([row('bbj_enabled', 'no')], 100).enabled).toBe(false);
});
it('main on requires a valid mini switch', () => {
  expect(() =>
    resolve(
      enabled().filter((r) => r.name !== 'mini_bbj_enabled'),
      100
    )
  ).toThrow('unset:mini_bbj_enabled');
  expect(() =>
    resolve(
      enabled().map((r) => (r.name === 'mini_bbj_enabled' ? { ...r, value_text: 'unknown' } : r)),
      100
    )
  ).toThrow('unreadable:mini_bbj_enabled');
});
it.each([true, false, '', ' ', '3.5', -1, null])('rejects coerced whole-Diamond fee %s', (raw) => {
  expect(() =>
    resolve(
      enabled().map((r) =>
        r.name === 'bbj_drop_per_hand' ? ({ ...r, value: raw } as EconomicsRow) : r
      ),
      100
    )
  ).toThrow('unreadable:bbj_drop_per_hand');
});
it('collects only eligible dealt flops and does not confuse hit minimum with drop minimum', () => {
  const s = resolve(enabled(), 100),
    f = { pot: 500, dealtIn: 3, sawFlop: true, variant: 'nlh', doubleBoard: false };
  expect(price(s, f)).toBe(3);
  for (const change of [
    { sawFlop: false },
    { dealtIn: 2 },
    { variant: 'plo6' },
    { doubleBoard: true },
  ])
    expect(price(s, { ...f, ...change })).toBe(0);
});
it('worker JSON preserves the hand schedule', () => {
  const fees = snapshotDiamondCashFees({
    enabled: false,
    bigBlind: 100,
    jackpot: resolve(enabled(), 100),
  });
  expect(
    priceDiamondCashFees(JSON.parse(JSON.stringify(fees)), {
      pot: 1001,
      dealtIn: 3,
      sawFlop: true,
      variant: 'nlh',
      doubleBoard: false,
    })
  ).toEqual({ rake: 0, bbjFee: 3 });
});
