/**
 * ═══ THE DIAMOND CASH RAKE IS THE OWNER'S NUMBER ═════════════════════════
 *
 * The settler recomputes the rake from `ca_diamond_economics` and refuses the
 * hand when the engine's number differs by one Diamond, so these tests are
 * about one thing: the engine's arithmetic IS the settler's arithmetic.
 *
 * NO EXPECTED RAKE IS A LITERAL. Every expectation is recomputed from the
 * settings ROWS below by `scheduledRake` - a deliberately SECOND expression of
 * the rule, written the obvious way with Math.floor and Math.min, so that it
 * and the pricer can disagree and be caught doing it. Change a row and the
 * expectation moves with it; the one place a number is stated outright is the
 * row itself, which is what the owner publishes.
 *
 * The rows are production's published answers on 2026-10-06, read live through
 * `fn_ca_diamond_economic`. They are a FIXTURE of what was published, not a
 * schedule this code owns: nothing in `src/` outside this file holds any of
 * them, which tests/the-diamond-cash-rake-is-priced-by-its-settings.law.test.ts
 * holds as a law.
 */
import { describe, expect, it } from 'vitest';
import {
  DiamondCashRakeSettingRefusal,
  diamondRakeBracketFor,
  priceDiamondCashRake,
  resolveDiamondCashRakeSchedule,
  type EconomicsRow,
} from './diamondCashRakeSchedule.js';

let nextId = 1;
const num = (name: string, scope: string, value: number | null): EconomicsRow => ({
  name,
  scope,
  value,
  value_text: null,
  recorded_at: '2026-10-05T00:00:00.000Z',
  id: nextId++,
});
const word = (name: string, value: string | null): EconomicsRow => ({
  name,
  scope: 'all',
  value: null,
  value_text: value,
  recorded_at: '2026-10-05T00:00:00.000Z',
  id: nextId++,
});

/** The cap ladder as the owner published it: 17 rungs, three brackets. */
const CAPS: Array<[number, number, number, number]> = [
  // [big blind, cap, cap heads-up, cap three-handed]
  [2, 30, 15, 30],
  [5, 75, 37, 75],
  [10, 150, 75, 150],
  [20, 300, 150, 300],
  [25, 300, 150, 300],
  [50, 300, 150, 300],
  [100, 500, 250, 500],
  [200, 500, 250, 500],
  [400, 750, 375, 750],
  [500, 750, 375, 750],
  [600, 800, 400, 800],
  [800, 1000, 500, 1000],
  [1000, 1250, 625, 1250],
  [2000, 1500, 750, 1500],
  [2500, 1500, 750, 1500],
  [5000, 2000, 1000, 2000],
  [10000, 2000, 1000, 2000],
];

function publishedRows(): EconomicsRow[] {
  const rows: EconomicsRow[] = [
    word('cash_rake_enabled', 'yes'),
    word('cash_rake_no_flop_no_drop', 'yes'),
    word('cash_rake_rounding', 'down'),
    num('cash_rake_min_pot', 'all', 0),
    num('cash_rake_percent', 'all', 10),
    num('cash_rake_percent_heads_up', 'all', 5),
    num('cash_rake_percent_three_handed', 'all', 10),
  ];
  for (const [bb, cap, capHu, cap3] of CAPS) {
    rows.push(num('cash_rake_cap', `bb:${bb}`, cap));
    rows.push(num('cash_rake_cap_heads_up', `bb:${bb}`, capHu));
    rows.push(num('cash_rake_cap_three_handed', `bb:${bb}`, cap3));
  }
  return rows;
}

const scheduleAt = (bigBlind: number, rows = publishedRows()) =>
  resolveDiamondCashRakeSchedule(rows, bigBlind);

/** The number a row says, pulled out of the rows rather than retyped. */
function rowNumber(rows: readonly EconomicsRow[], name: string, scope: string): number {
  const found = rows.filter((row) => row.name === name && row.scope === scope);
  expect(found.length, `${name}/${scope} is not published`).toBe(1);
  return Number(found[0].value);
}

/**
 * THE SECOND OPINION. `least(trunc(pot * pct / 100), cap)` with the brackets
 * and the three zero branches, written plainly from the ROWS. Its whole job is
 * to be a different expression of the same rule, computed from the published
 * answers, so a pricer that drifts has something to be caught by.
 */
function scheduledRake(
  rows: readonly EconomicsRow[],
  bigBlind: number,
  pot: number,
  dealtIn: number,
  sawFlop: boolean
): number {
  if (dealtIn < 2) return 0;
  const suffix = dealtIn <= 2 ? '_heads_up' : dealtIn === 3 ? '_three_handed' : '';
  if (
    !sawFlop &&
    rows.some((r) => r.name === 'cash_rake_no_flop_no_drop' && r.value_text === 'yes')
  )
    return 0;
  if (pot < rowNumber(rows, 'cash_rake_min_pot', 'all')) return 0;
  return Math.min(
    Math.floor((pot * rowNumber(rows, `cash_rake_percent${suffix}`, 'all')) / 100),
    rowNumber(rows, `cash_rake_cap${suffix}`, `bb:${bigBlind}`)
  );
}

describe("the engine prices a Diamond cash hand at the owner's published number", () => {
  it('brackets by players dealt in, exactly where the settler brackets', () => {
    /* `v_dealt <= 2 THEN '_heads_up' WHEN v_dealt = 3 THEN '_three_handed'
       ELSE ''` - including that two is heads-up and four is not three-handed. */
    expect(diamondRakeBracketFor(0)).toBe('_heads_up');
    expect(diamondRakeBracketFor(2)).toBe('_heads_up');
    expect(diamondRakeBracketFor(3)).toBe('_three_handed');
    expect(diamondRakeBracketFor(4)).toBe('');
    expect(diamondRakeBracketFor(9)).toBe('');
  });

  it('agrees with the schedule on a flopped multiway pot under the cap', () => {
    const rows = publishedRows();
    const schedule = scheduleAt(2, rows);
    for (const [pot, dealtIn] of [
      [80, 3],
      [80, 6],
      [120, 4],
      [200, 9],
      [33, 3],
    ] as Array<[number, number]>) {
      const expected = scheduledRake(rows, 2, pot, dealtIn, true);
      expect(expected, `pot ${pot} / ${dealtIn} dealt should be under the cap`).toBeLessThan(
        rowNumber(rows, dealtIn === 3 ? 'cash_rake_cap_three_handed' : 'cash_rake_cap', 'bb:2')
      );
      expect(priceDiamondCashRake(schedule, { pot, dealtIn, sawFlop: true })).toBe(expected);
    }
  });

  it('is held by the cap at every rung of the ladder, in all three brackets', () => {
    const rows = publishedRows();
    for (const [bb] of CAPS) {
      const schedule = scheduleAt(bb, rows);
      for (const dealtIn of [2, 3, 6]) {
        const suffix = dealtIn === 2 ? '_heads_up' : dealtIn === 3 ? '_three_handed' : '';
        const cap = rowNumber(rows, `cash_rake_cap${suffix}`, `bb:${bb}`);
        const percent = rowNumber(rows, `cash_rake_percent${suffix}`, 'all');
        /* A pot comfortably past the capping point, and the one exactly at it. */
        const capsAt = Math.ceil((cap * 100) / percent);
        for (const pot of [capsAt, capsAt + 1, capsAt * 7]) {
          const expected = scheduledRake(rows, bb, pot, dealtIn, true);
          expect(expected, `bb:${bb} / ${dealtIn} dealt / pot ${pot} should cap`).toBe(cap);
          expect(priceDiamondCashRake(schedule, { pot, dealtIn, sawFlop: true })).toBe(expected);
        }
        /* And one Diamond short of the capping point does NOT cap. */
        const under = capsAt - 1;
        if (under > 0) {
          const expected = scheduledRake(rows, bb, under, dealtIn, true);
          expect(expected).toBeLessThan(cap);
          expect(priceDiamondCashRake(schedule, { pot: under, dealtIn, sawFlop: true })).toBe(
            expected
          );
        }
      }
    }
  });

  it('prices heads-up at the heads-up percent, and floors at the bb:5 rung', () => {
    const rows = publishedRows();
    /* THE ONE RUNG THAT FLOORS. 75 halves to 37.5 and the owner published 37,
       so this rung is the one place a cap is not half of the full cap. It is
       named here because it is exactly where a pricer that re-derives the
       heads-up cap instead of READING it would be caught. */
    expect(rowNumber(rows, 'cash_rake_cap_heads_up', 'bb:5') * 2).toBe(
      rowNumber(rows, 'cash_rake_cap', 'bb:5') - 1
    );
    const schedule = scheduleAt(5, rows);
    const expected = scheduledRake(rows, 5, 1000, 2, true);
    expect(expected).toBe(rowNumber(rows, 'cash_rake_cap_heads_up', 'bb:5'));
    expect(priceDiamondCashRake(schedule, { pot: 1000, dealtIn: 2, sawFlop: true })).toBe(expected);
    /* The heads-up percent is the lower one, and it is the one applied. */
    const belowCap = scheduledRake(rows, 5, 100, 2, true);
    expect(belowCap).toBe(
      Math.floor((100 * rowNumber(rows, 'cash_rake_percent_heads_up', 'all')) / 100)
    );
    expect(priceDiamondCashRake(schedule, { pot: 100, dealtIn: 2, sawFlop: true })).toBe(belowCap);
    /* ... and it is NOT the four-or-more percent, or this test proves nothing. */
    expect(rowNumber(rows, 'cash_rake_percent_heads_up', 'all')).not.toBe(
      rowNumber(rows, 'cash_rake_percent', 'all')
    );
  });

  it('prices three-handed at the three-handed percent and cap', () => {
    const rows = publishedRows();
    const schedule = scheduleAt(2, rows);
    for (const pot of [40, 299, 300, 301, 5000]) {
      expect(priceDiamondCashRake(schedule, { pot, dealtIn: 3, sawFlop: true })).toBe(
        scheduledRake(rows, 2, pot, 3, true)
      );
    }
  });

  it('rakes nothing when no flop was dealt, at any pot', () => {
    const rows = publishedRows();
    const schedule = scheduleAt(2, rows);
    for (const pot of [0, 20, 80, 1_000_000]) {
      expect(scheduledRake(rows, 2, pot, 3, false)).toBe(0);
      expect(priceDiamondCashRake(schedule, { pot, dealtIn: 3, sawFlop: false })).toBe(0);
    }
    /* And the same pot WITH a flop is raked, so the zero above is the rule
       firing rather than the schedule being empty. */
    expect(priceDiamondCashRake(schedule, { pot: 80, dealtIn: 3, sawFlop: true })).toBeGreaterThan(
      0
    );
  });

  it('rakes nothing from a pot too small to yield one whole Diamond', () => {
    const rows = publishedRows();
    const schedule = scheduleAt(2, rows);
    const percent = rowNumber(rows, 'cash_rake_percent_three_handed', 'all');
    /* trunc(pot * pct / 100) = 0 for every pot below one Diamond's worth. */
    const firstRakedPot = Math.ceil(100 / percent);
    for (let pot = 0; pot < firstRakedPot; pot++) {
      expect(scheduledRake(rows, 2, pot, 3, true)).toBe(0);
      expect(priceDiamondCashRake(schedule, { pot, dealtIn: 3, sawFlop: true })).toBe(0);
    }
    expect(priceDiamondCashRake(schedule, { pot: firstRakedPot, dealtIn: 3, sawFlop: true })).toBe(
      1
    );
  });

  it('truncates and never rounds: one Diamond below the next whole one', () => {
    const rows = publishedRows();
    const schedule = scheduleAt(2, rows);
    /* A pot whose percent lands on .9 must still truncate down. */
    for (const pot of [19, 29, 39, 199, 299]) {
      const exact = (pot * rowNumber(rows, 'cash_rake_percent_three_handed', 'all')) / 100;
      expect(Number.isInteger(exact), `pot ${pot} should be fractional`).toBe(false);
      expect(priceDiamondCashRake(schedule, { pot, dealtIn: 3, sawFlop: true })).toBe(
        Math.floor(exact)
      );
      expect(priceDiamondCashRake(schedule, { pot, dealtIn: 3, sawFlop: true })).not.toBe(
        Math.round(exact)
      );
    }
  });

  it('rakes nothing when fewer than two players were dealt in', () => {
    const schedule = scheduleAt(2);
    for (const dealtIn of [0, 1])
      expect(priceDiamondCashRake(schedule, { pot: 10_000, dealtIn, sawFlop: true })).toBe(0);
  });

  it('prices a fractional percent exactly, as numeric does and a float cannot', () => {
    /* 10.1% of 1000 is 101 exactly. In IEEE 754, 1000 * 10.1 / 100 is
       101.00000000000001, and 1000 * 0.101 is 101.00000000000001 too - both
       fine here, but the same arithmetic at other pots lands a hair BELOW an
       integer and truncates one Diamond low, which is a refused hand. The
       pricer carries the percent as an exact scaled integer so the boundary
       cases land where PostgreSQL's numeric puts them. */
    const rows = [
      ...publishedRows().filter((row) => row.name !== 'cash_rake_percent_three_handed'),
      num('cash_rake_percent_three_handed', 'all', 10.1),
    ];
    /* The top rung, so the cap is nowhere near and the percent term is the
       only thing under test. */
    const schedule = scheduleAt(10000, rows);
    for (const pot of [1000, 10, 100, 70, 130, 1270]) {
      /* The exact decimal answer, computed in integers: floor(pot * 101 / 1000). */
      expect(priceDiamondCashRake(schedule, { pot, dealtIn: 3, sawFlop: true })).toBe(
        Math.floor((pot * 101) / 1000)
      );
    }
  });

  it('answers zero for every hand when the switch is off, and reads nothing else', () => {
    /* The switch off is an ANSWER: the settler reads no percent and no cap, so
       a schedule with the switch off must not require them to exist either -
       a table whose rake is switched off has to be able to deal. */
    const off = resolveDiamondCashRakeSchedule([word('cash_rake_enabled', 'no')], 2);
    expect(off.enabled).toBe(false);
    expect(priceDiamondCashRake(off, { pot: 1_000_000, dealtIn: 6, sawFlop: true })).toBe(0);
    /* Absent is the same answer as off - the settler catches PDE01 into false. */
    const absent = resolveDiamondCashRakeSchedule([], 2);
    expect(absent.enabled).toBe(false);
    expect(priceDiamondCashRake(absent, { pot: 1_000_000, dealtIn: 6, sawFlop: true })).toBe(0);
  });

  it("refuses a rounding it cannot honour, by the settler's own name", () => {
    const rows = [
      ...publishedRows().filter((row) => row.name !== 'cash_rake_rounding'),
      word('cash_rake_rounding', 'nearest'),
    ];
    const schedule = scheduleAt(2, rows);
    expect(() => priceDiamondCashRake(schedule, { pot: 80, dealtIn: 3, sawFlop: true })).toThrow(
      'diamond_cash_rake_rounding_unsupported:nearest'
    );
    /* And it refuses BEFORE the zero branches, so an unhonourable rounding is
       never quietly turned into a rake of nothing. */
    expect(() => priceDiamondCashRake(schedule, { pot: 0, dealtIn: 3, sawFlop: false })).toThrow(
      'diamond_cash_rake_rounding_unsupported'
    );
  });

  it('refuses a pot that is not a whole number of Diamonds', () => {
    const schedule = scheduleAt(2);
    for (const pot of [0.5, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => priceDiamondCashRake(schedule, { pot, dealtIn: 3, sawFlop: true })).toThrow(
        DiamondCashRakeSettingRefusal
      );
  });

  it('applies the cap AFTER the truncation, never before', () => {
    /* If the cap were applied first the answer would be trunc(min(pot, cap) *
       pct / 100), which is smaller at every capped pot. One pot distinguishes
       them, and the published schedule is asserted to be on the right side. */
    const rows = publishedRows();
    const schedule = scheduleAt(2, rows);
    const cap = rowNumber(rows, 'cash_rake_cap_three_handed', 'bb:2');
    const percent = rowNumber(rows, 'cash_rake_percent_three_handed', 'all');
    const pot = Math.ceil((cap * 100) / percent) * 3;
    expect(priceDiamondCashRake(schedule, { pot, dealtIn: 3, sawFlop: true })).toBe(cap);
    expect(Math.floor((Math.min(pot, cap) * percent) / 100)).not.toBe(cap);
  });
});

describe('the published rows are read as the database reader reads them', () => {
  it('lets the newest row supersede an older one, as ORDER BY recorded_at DESC does', () => {
    const rows: EconomicsRow[] = [
      ...publishedRows(),
      {
        name: 'cash_rake_percent_three_handed',
        scope: 'all',
        value: 4,
        value_text: null,
        recorded_at: '2026-10-06T00:00:00.000Z',
        id: 9001,
      },
    ];
    const schedule = scheduleAt(2, rows);
    /* The owner changed the answer with one INSERT, and the engine is priced
       by the new one with no code change - which is the whole point. */
    expect(priceDiamondCashRake(schedule, { pot: 100, dealtIn: 3, sawFlop: true })).toBe(4);
  });

  it('breaks a same-timestamp tie by id, as ORDER BY id DESC does', () => {
    const at = '2026-10-06T00:00:00.000Z';
    const rows: EconomicsRow[] = [
      ...publishedRows(),
      { ...num('cash_rake_percent_three_handed', 'all', 7), recorded_at: at, id: 500 },
      { ...num('cash_rake_percent_three_handed', 'all', 3), recorded_at: at, id: 501 },
    ];
    expect(priceDiamondCashRake(scheduleAt(2, rows), { pot: 100, dealtIn: 3, sawFlop: true })).toBe(
      3
    );
  });

  it('treats a newest row with no value as UNSET, and never falls back to an older one', () => {
    /* The reader picks the newest row and THEN checks for NULL. It does not
       skip past a blank answer to a stale one: an unset number is a refusal a
       client can read, not the previous number still in force. */
    const rows: EconomicsRow[] = [
      ...publishedRows(),
      {
        name: 'cash_rake_percent_three_handed',
        scope: 'all',
        value: null,
        value_text: null,
        recorded_at: '2026-10-06T00:00:00.000Z',
        id: 9002,
      },
    ];
    expect(() => scheduleAt(2, rows)).toThrow(
      'diamond_economics_unset:cash_rake_percent_three_handed/all'
    );
  });

  it('never falls back from one stake to another, or to the all scope', () => {
    const rows = publishedRows().filter(
      (row) => !(row.name === 'cash_rake_cap' && row.scope === 'bb:100')
    );
    expect(() => scheduleAt(100, rows)).toThrow('diamond_economics_unset:cash_rake_cap/bb:100');
    /* A cap published at `all` is still not this stake's cap. */
    expect(() => scheduleAt(100, [...rows, num('cash_rake_cap', 'all', 9999)])).toThrow(
      'diamond_economics_unset:cash_rake_cap/bb:100'
    );
    /* And an unpublished stake refuses even though every other rung exists. */
    expect(() => scheduleAt(7, publishedRows())).toThrow('diamond_economics_unset:cash_rake_cap');
  });

  it('refuses an unset no-flop-no-drop rather than reading it as off', () => {
    /* The settler wraps ONLY `cash_rake_enabled` in its PDE01 handler, so an
       unset `cash_rake_no_flop_no_drop` raises out of it. Reading it as off
       here would make the engine rake an unflopped pot that the settler then
       refuses to settle at all. */
    const rows = publishedRows().filter((row) => row.name !== 'cash_rake_no_flop_no_drop');
    expect(() => scheduleAt(2, rows)).toThrow(
      'diamond_economics_unset:cash_rake_no_flop_no_drop/all'
    );
  });

  it('refuses a stake that is not a whole positive number of Diamonds', () => {
    for (const bb of [0, -2, 2.5, Number.NaN])
      expect(() => scheduleAt(bb)).toThrow(DiamondCashRakeSettingRefusal);
  });

  it('reads every rung of the published ladder without a gap', () => {
    for (const [bb] of CAPS) expect(scheduleAt(bb).enabled).toBe(true);
  });
});
