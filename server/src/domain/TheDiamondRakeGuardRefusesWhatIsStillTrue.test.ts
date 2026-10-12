/**
 * ═══ WHAT THE ACCEPTED-HAND GUARD STILL REFUSES ══════════════════════════
 *
 * `assertDiamondAcceptedHand` used to refuse ANY non-zero rake on a Diamond
 * hand. That was correct while no Diamond rake existed and became the thing
 * standing between the owner's published settings and an open cash felt. The
 * check was narrowed rather than deleted, and this file is the statement of
 * what it was narrowed TO: every refusal below is one that is still true, and
 * every other assertion the guard makes is pinned here as well, so a later
 * narrowing cannot quietly take one of them with it.
 */
import { describe, expect, it } from 'vitest';
import { assertDiamondAcceptedHand, DIAMOND_CASH_VARIANTS } from './DiamondCashBoundary.js';
import {
  priceDiamondCashRake,
  resolveDiamondCashRakeSchedule,
  type EconomicsRow,
} from './diamondCashRakeSchedule.js';

let nextId = 1;
const r = (
  name: string,
  scope: string,
  value: number | null,
  value_text: string | null = null
): EconomicsRow => ({
  name,
  scope,
  value,
  value_text,
  recorded_at: '2026-10-05T00:00:00.000Z',
  id: nextId++,
});

/** The owner's published answers at bb:2. */
const ROWS: EconomicsRow[] = [
  r('cash_rake_enabled', 'all', null, 'yes'),
  r('cash_rake_no_flop_no_drop', 'all', null, 'yes'),
  r('cash_rake_rounding', 'all', null, 'down'),
  r('cash_rake_min_pot', 'all', 0),
  r('cash_rake_percent', 'all', 10),
  r('cash_rake_percent_heads_up', 'all', 5),
  r('cash_rake_percent_three_handed', 'all', 10),
  r('cash_rake_cap', 'bb:2', 30),
  r('cash_rake_cap_heads_up', 'bb:2', 15),
  r('cash_rake_cap_three_handed', 'bb:2', 30),
];
const SCHEDULE = resolveDiamondCashRakeSchedule(ROWS, 2);
const FACTS = { pot: 80, dealtIn: 3, sawFlop: true };
/** Recomputed, never typed in. */
const PRICED = priceDiamondCashRake(SCHEDULE, FACTS);

const hand = () => ({
  arena: { id: 'arena', kind: 'diamond_arena', asset: 'diamonds' } as const,
  verifiedLease: true,
  variant: 'nlh',
  rake: PRICED,
  bbj: 0,
  inflow: 0,
  insuranceCount: 0,
  amounts: [80, 70, 132, 90],
  rakeSchedule: SCHEDULE,
  rakeFacts: FACTS,
});

describe('the Diamond accepted-hand guard admits the settings number and nothing else', () => {
  it('admits the rake the settings price, which is not zero', () => {
    expect(PRICED).toBeGreaterThan(0);
    expect(() => assertDiamondAcceptedHand(hand())).not.toThrow();
    /* ... in every game this arena deals. */
    for (const variant of DIAMOND_CASH_VARIANTS)
      expect(() => assertDiamondAcceptedHand({ ...hand(), variant })).not.toThrow();
  });

  it('refuses a rake one Diamond either side of the settings number', () => {
    for (const rake of [PRICED - 1, PRICED + 1])
      expect(() => assertDiamondAcceptedHand({ ...hand(), rake })).toThrow(
        'diamond_cash_rake_disagrees'
      );
  });

  it('refuses an engine that silently stopped raking', () => {
    /* A zero is as wrong as a wrong number when the settings say otherwise,
       and it is the failure that would otherwise be invisible. */
    expect(() => assertDiamondAcceptedHand({ ...hand(), rake: 0 })).toThrow(
      'diamond_cash_rake_disagrees'
    );
  });

  it('refuses a rake that is not a whole Diamond', () => {
    for (const rake of [0.5, PRICED + 0.5, 1 / 3])
      expect(() => assertDiamondAcceptedHand({ ...hand(), rake })).toThrow(
        'diamond_whole_rake_required'
      );
  });

  it('refuses a negative rake', () => {
    for (const rake of [-1, -PRICED])
      expect(() => assertDiamondAcceptedHand({ ...hand(), rake })).toThrow(
        'diamond_whole_rake_required'
      );
  });

  it('refuses a rake the settings say is not owed', () => {
    /* No separate branch does this: the re-price answers zero and the
       comparison fails. One rule, four ways of being unraked. */
    for (const facts of [
      { pot: 80, dealtIn: 3, sawFlop: false }, // no flop, no drop
      { pot: 80, dealtIn: 1, sawFlop: true }, // fewer than two dealt in
      { pot: 9, dealtIn: 3, sawFlop: true }, // 10% of 9 truncates to zero
    ]) {
      expect(priceDiamondCashRake(SCHEDULE, facts)).toBe(0);
      expect(() => assertDiamondAcceptedHand({ ...hand(), rakeFacts: facts, rake: 1 })).toThrow(
        'diamond_cash_rake_disagrees'
      );
      /* ... and zero on those same facts is admitted. */
      expect(() =>
        assertDiamondAcceptedHand({ ...hand(), rakeFacts: facts, rake: 0 })
      ).not.toThrow();
    }
    /* And with the switch off, every rake but zero is refused. */
    const off = resolveDiamondCashRakeSchedule([r('cash_rake_enabled', 'all', null, 'no')], 2);
    expect(() => assertDiamondAcceptedHand({ ...hand(), rakeSchedule: off, rake: PRICED })).toThrow(
      'diamond_cash_rake_disagrees'
    );
    expect(() =>
      assertDiamondAcceptedHand({ ...hand(), rakeSchedule: off, rake: 0 })
    ).not.toThrow();
  });

  it('refuses any rake at all on a hand that carries no Diamond schedule', () => {
    /* A Diamond tournament hand, and any path that reaches this door without
       having read the settings. The original rule - exactly zero - still
       holds there, because a rake nothing published is a rake nothing can
       justify. */
    for (const missing of [
      { rakeSchedule: null, rakeFacts: null },
      { rakeSchedule: undefined, rakeFacts: undefined },
      { rakeSchedule: SCHEDULE, rakeFacts: null },
      { rakeSchedule: null, rakeFacts: FACTS },
    ]) {
      expect(() => assertDiamondAcceptedHand({ ...hand(), ...missing, rake: 1 })).toThrow(
        'diamond_plain_cash_required'
      );
      expect(() => assertDiamondAcceptedHand({ ...hand(), ...missing, rake: 0 })).not.toThrow();
    }
  });

  it('refuses a schedule it cannot price, rather than pricing it anyway', () => {
    const unhonourable = resolveDiamondCashRakeSchedule(
      [
        ...ROWS.filter((row) => row.name !== 'cash_rake_rounding'),
        r('cash_rake_rounding', 'all', null, 'nearest'),
      ],
      2
    );
    expect(() => assertDiamondAcceptedHand({ ...hand(), rakeSchedule: unhonourable })).toThrow(
      'diamond_cash_rake_unpriceable'
    );
  });

  it('keeps every other assertion it made', () => {
    /* NOTHING ELSE MOVED. Each of these refused before the narrowing and
       still refuses, by the same name. */
    expect(() => assertDiamondAcceptedHand({ ...hand(), verifiedLease: false })).toThrow(
      'diamond_lease_required'
    );
    for (const variant of ['stud', 'razz', 'NLH', ''])
      expect(() => assertDiamondAcceptedHand({ ...hand(), variant })).toThrow(
        'diamond_plain_cash_required'
      );
    for (const change of [{ bbj: 1 }, { inflow: 1 }, { insuranceCount: 1 }])
      expect(() => assertDiamondAcceptedHand({ ...hand(), ...change })).toThrow(
        'diamond_plain_cash_required'
      );
    for (const amounts of [[1.5], [-1], [Number.NaN], [2147483648]])
      expect(() => assertDiamondAcceptedHand({ ...hand(), amounts })).toThrow(
        'diamond_whole_amount_required'
      );
    /* And it still does nothing at all on a chip hand. */
    expect(() =>
      assertDiamondAcceptedHand({
        ...hand(),
        arena: { id: 'chip', kind: 'chip_club', asset: 'chips' },
        verifiedLease: false,
        rake: 0.1,
        amounts: [0.25],
        rakeSchedule: null,
        rakeFacts: null,
      })
    ).not.toThrow();
  });

  it('prices a horse seat and a human seat by the same call (CLAUDE.md 10.5)', () => {
    /* There is no seat in `rakeFacts` to tell them apart. The pin is that the
       guard's inputs cannot express the distinction: a pot, a count and a
       flop fact, with no user, no seat and no is_horse anywhere. */
    expect(Object.keys(FACTS).sort()).toEqual(['dealtIn', 'pot', 'sawFlop']);
  });
});
