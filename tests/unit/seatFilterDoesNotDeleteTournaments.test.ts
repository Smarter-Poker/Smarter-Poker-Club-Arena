/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN UNTOUCHED SLIDER DELETED EVERY MTT IN THE CLUB
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "THE MTT, SPINS AND HEADS UP TABLES AND EVENTS THAT WERE
 * CREATED IN THE MIDWAY UNION ARE NOT BEING DISPLAYED IN THE ATTACHED CLUBS."
 *
 * Measured in his own browser, after the database side was fixed: Club JAQK
 * showed 33 Spins, 17 Heads Up and 24 MTTs. Shark Club and Midway, the same
 * union and the same 86 games, showed the Spins and the Heads Up and an EMPTY
 * MTT tab. The only difference between the clubs was a saved advanced-filter
 * value in localStorage -- untouched, sitting at its default `seatMin: 2,
 * seatMax: 9`.
 *
 * TWO FAULTS, AND THE SECOND IS THE ONE THAT MATTERS.
 *
 *  1. FILTER_SPECS.MTT.seats is { min: 2, max: 9 } and its label is "Table
 *     Size", but rowPassesFilter was handed `seats: max_players` -- the FIELD
 *     cap, 150 to 1,000. Every MTT that has ever existed fails a 2-9 test.
 *     The slider was made live in an earlier pass ("the MTT and SNG sliders
 *     were previously inert") without noticing it was now measuring the wrong
 *     quantity. The seats at one table is table_size, which every live
 *     tournament carries and which is 2, 3, 6 or 9.
 *
 *  2. isFilterActive() called that default-valued range INACTIVE while
 *     rowPassesFilter enforced it. So the lobby's empty state read "Nothing
 *     Here On This Tab -- 129 Games Are Open In This Club, Just None Of This
 *     Type", offered no filter to clear, and was wrong: there were 24 of that
 *     type and a filter nobody had set was deleting them. Two functions
 *     disagreeing about whether a filter is set is the whole bug.
 *
 * These tests pin both halves.
 */

import { describe, it, expect } from 'vitest';
import {
  FILTER_SPECS,
  emptyFilterValue,
  isFilterActive,
  rowPassesFilter,
} from '../../src/components/lobby/advancedFilterSpec';

const mttSpec = FILTER_SPECS.MTT;

/** A real row from Midway Union: a 500-runner MTT played nine to a table. */
const bigMtt = {
  variant: 'NLH',
  price: 50,
  seats: 500, // max_players -- the FIELD
  tableSeats: 9, // table_size -- the TABLE
  seatsTaken: 36,
  status: 'REGISTERING',
  name: 'Sunday Mystery Million',
  row: {},
  settings: {},
};

describe('a default seat range is not a filter', () => {
  const value = emptyFilterValue(mttSpec);

  it('agrees with isFilterActive that nothing is set', () => {
    expect(isFilterActive(mttSpec, value)).toBe(false);
  });

  it('keeps every MTT, which is what "nothing is set" has to mean', () => {
    expect(rowPassesFilter(mttSpec, value, bigMtt)).toBe(true);
  });

  it('keeps it even when the row only knows its field size', () => {
    const { tableSeats: _dropped, ...fieldOnly } = bigMtt;
    expect(rowPassesFilter(mttSpec, value, fieldOnly)).toBe(true);
  });
});

describe('"Table Size" measures the table, not the field', () => {
  it('keeps a 500-runner nine-handed MTT when the slider asks for 9', () => {
    const value = { ...emptyFilterValue(mttSpec), seatMin: 9, seatMax: 9 };
    expect(isFilterActive(mttSpec, value)).toBe(true);
    expect(rowPassesFilter(mttSpec, value, bigMtt)).toBe(true);
  });

  it('drops that same MTT when the slider asks for six-max', () => {
    const value = { ...emptyFilterValue(mttSpec), seatMin: 2, seatMax: 6 };
    expect(rowPassesFilter(mttSpec, value, bigMtt)).toBe(false);
  });

  it('never hides a tournament whose table size is unknown', () => {
    // Absence of evidence is not evidence of a 500-seat table. The key is
    // present and null, which is how ClubHomePage reports "no table_size".
    const value = { ...emptyFilterValue(mttSpec), seatMin: 2, seatMax: 6 };
    expect(rowPassesFilter(mttSpec, value, { ...bigMtt, tableSeats: null })).toBe(true);
  });
});

describe('cash tables are untouched by any of this', () => {
  const cashSpec = FILTER_SPECS.HOLDEM;

  it('still filters a cash table on its seat count', () => {
    if (!cashSpec?.seats) return; // spec has no slider; nothing to pin
    const table = {
      variant: 'NLH',
      price: 2,
      seats: 9,
      seatsTaken: 5,
      name: 'NLH 1/2',
      row: {},
      settings: {},
    };
    const narrow = { ...emptyFilterValue(cashSpec), seatMin: 2, seatMax: 6 };
    expect(rowPassesFilter(cashSpec, narrow, table)).toBe(false);

    const wide = emptyFilterValue(cashSpec);
    expect(rowPassesFilter(cashSpec, wide, table)).toBe(true);
  });
});
