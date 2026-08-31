/**
 * THE BLIND LADDER, THE RAKE SCHEDULE, AND THE LIMIT BET LADDER.
 *
 * Two findings from the 2026-08-31 game-creation audit live here. One is
 * FIXED; the other is a PRICING DECISION that belongs to Dan and is recorded
 * rather than changed, because RAKE_SCHEDULE is a money table.
 */
import { describe, it, expect } from 'vitest';
import {
  BLINDS_PRESETS,
  LIMIT_BLINDS_PRESETS,
  presetsFor,
  blindsIndexFor,
} from '../../src/config/blindsPresets';
import { findScheduleMatch, getTierForBB, MAX_RAKE_CAP_BB } from '../../src/config/RakeConfig';

describe('a fixed-limit table is only offered blinds its bet ladder can describe', () => {
  /**
   * fixedLimitBetSize() derives the whole ladder from the BIG BLIND — small
   * bet 1x BB, big bet 2x BB — and stakesLabel() names the table by those bet
   * sizes. The small blind is not a term in either. So on a preset where the
   * big blind is not twice the small blind, an FLO8 table stored as
   * small_blind 0.1 / big_blind 0.25 was labelled "0.25/0.50" in
   * tables.stakes, on its lobby row and in its header, and the 0.10 a player
   * actually posts appeared NOWHERE. The DB guard accepts it — it only
   * requires bb > sb > 0 — so nothing downstream would have caught it.
   */
  it('offers only presets where the big blind is twice the small blind', () => {
    for (const preset of LIMIT_BLINDS_PRESETS) {
      expect(preset.bb).toBeCloseTo(preset.sb * 2, 10);
    }
  });

  it('names the four presets a limit table can no longer be built on', () => {
    const excluded = BLINDS_PRESETS.filter((p) => !LIMIT_BLINDS_PRESETS.includes(p)).map(
      (p) => p.label
    );
    expect(excluded).toEqual(['0.02/0.05', '0.10/0.25', '2/5', '10/25']);
  });

  it('leaves the no-limit ladder untouched', () => {
    expect(presetsFor(false)).toBe(BLINDS_PRESETS);
    expect(presetsFor(false)).toHaveLength(12);
    expect(presetsFor(true)).toHaveLength(8);
  });

  it('every offered limit preset is still reachable by the slider', () => {
    LIMIT_BLINDS_PRESETS.forEach((preset, i) => {
      expect(blindsIndexFor(preset.sb, preset.bb, LIMIT_BLINDS_PRESETS)).toBe(i);
    });
  });
});

describe('the rake schedule does not cover the ladder the form offers', () => {
  /**
   * NOT A FIX — A RECORD, and Dan's decision to make. RAKE_SCHEDULE is a money
   * table; the DB creation guard says so itself, declining to police this:
   * "NOT enforced here and left for Dan: the official stakes schedule."
   *
   * Six of the twelve presets have no schedule row, so findScheduleMatch
   * returns null and getRakeConfig falls back to getTierForBB — a tier whose
   * cap is an absolute dollar amount. Expressed in big blinds, that fallback
   * prices the four cheapest games ABOVE MAX_RAKE_CAP_BB, which is the
   * ceiling the same file enforces on an explicit override:
   *
   *     0.01/0.02   $3 cap = 150 BB
   *     0.02/0.05   $3 cap =  60 BB
   *     0.05/0.10   $3 cap =  30 BB   <- THE DEFAULT PRESET
   *     0.10/0.25   $3 cap =  12 BB
   *
   * Every schedule-covered preset is 6 BB or less. Live exposure as of
   * 2026-08-31 is small — 2 cash tables at 0.05/0.10, both closed; the 972
   * others sit on covered stakes, 794 of them at 1/2 — but the DEFAULT sits
   * in the gap, so the next owner who accepts the defaults creates one.
   *
   * The fix is either to extend RAKE_SCHEDULE or to narrow BLINDS_PRESETS,
   * and both change what players pay. This test pins the gap at its current
   * size so it cannot grow unnoticed while that decision is open.
   */
  const unpriced = BLINDS_PRESETS.filter((p) => findScheduleMatch(p.sb, p.bb) === null);

  it('is exactly these six presets, no more', () => {
    expect(unpriced.map((p) => p.label)).toEqual([
      '0.01/0.02',
      '0.02/0.05',
      '0.05/0.10',
      '0.10/0.25',
      '25/50',
      '50/100',
    ]);
  });

  it('includes the default preset, which is why this matters', () => {
    const fallback = BLINDS_PRESETS.filter(
      (p) =>
        findScheduleMatch(p.sb, p.bb) === null &&
        getTierForBB(p.bb).rakeCap / p.bb > MAX_RAKE_CAP_BB
    );
    expect(fallback.map((p) => p.label)).toEqual([
      '0.01/0.02',
      '0.02/0.05',
      '0.05/0.10',
      '0.10/0.25',
    ]);
  });

  it('every preset the schedule DOES cover is capped at or under the ceiling', () => {
    for (const preset of BLINDS_PRESETS) {
      const match = findScheduleMatch(preset.sb, preset.bb);
      if (!match) continue;
      expect(match.rakeCap / preset.bb).toBeLessThanOrEqual(MAX_RAKE_CAP_BB);
    }
  });

  it.skip('AWAITING DAN: no offered preset may be priced above MAX_RAKE_CAP_BB', () => {
    // Delete the .skip in the commit that either extends RAKE_SCHEDULE to
    // cover all twelve presets, or narrows BLINDS_PRESETS to the schedule.
    for (const preset of BLINDS_PRESETS) {
      const match = findScheduleMatch(preset.sb, preset.bb);
      const cap = match ? match.rakeCap : getTierForBB(preset.bb).rakeCap;
      expect(cap / preset.bb).toBeLessThanOrEqual(MAX_RAKE_CAP_BB);
    }
  });

  it.skip('AWAITING DAN: the 5/5 schedule row can never match a legal table', () => {
    // RAKE_SCHEDULE contains { sb: 5, bb: 5 }. The table-creation guard
    // refuses "big blind must exceed small blind", so no table can ever
    // match it. 5/10 already exists; 2.5/5 would fit the ladder. It is a
    // money row — confirm the intended stakes with Dan before editing.
    expect(findScheduleMatch(5, 5)).toBeNull();
  });
});
