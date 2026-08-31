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
import {
  findScheduleMatch,
  getRakeConfig,
  RAKE_SCHEDULE,
  UNSCHEDULED_CAP_BB,
} from '../../src/config/RakeConfig';

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

describe('every stake the form offers is on the published schedule', () => {
  /**
   * DAN'S RULING, 2026-08-31, applied: "WE HAVE A SCALE THAT WE USE FOR THE
   * CASH GAME FOR RAKE AND BBJ, USE THE SAME PERCENTAGES WE USE FOR THE OTHER
   * GAMES, IF YOU DON'T HAVE A RAKE OR BBJ SCHEDULE FOR A SPECIFIC GAME."
   *
   * Six of the twelve presets had no row, so the price fell through to a
   * stakes TIER whose cap is an absolute dollar amount applied regardless of
   * stake. $3 on a $0.02 big blind is 150 BB; on the DEFAULT preset it was
   * 30 BB, against a published ladder whose most generous row is 15 BB and
   * whose typical row is 1 to 6 BB.
   *
   * Both halves of the ruling are pinned here: the six rows exist now, and
   * the FALLBACK for any stake nobody scheduled is held to the same
   * proportion rather than to a flat dollar figure.
   */
  it('leaves no preset priced by fallback', () => {
    const unpriced = BLINDS_PRESETS.filter((p) => findScheduleMatch(p.sb, p.bb) === null);
    expect(unpriced.map((p) => p.label)).toEqual([]);
  });

  it('charges the same percentage at every stake', () => {
    for (const preset of BLINDS_PRESETS) {
      expect(getRakeConfig(preset.bb, 'nlh', preset.sb).rakePercent).toBe(10);
    }
  });

  it("never caps any offered stake above the ladder's own most generous row", () => {
    // This is the invariant the old code broke. It was written as a .skip
    // against MAX_RAKE_CAP_BB, which was the wrong constant — that one bounds
    // operator OVERRIDES, and the schedule's own bottom rung has always been
    // 15 BB. Now it runs.
    expect(UNSCHEDULED_CAP_BB).toBe(15);
    for (const preset of BLINDS_PRESETS) {
      const { rakeCap } = getRakeConfig(preset.bb, 'nlh', preset.sb);
      expect(rakeCap / preset.bb).toBeLessThanOrEqual(UNSCHEDULED_CAP_BB);
    }
  });

  it('prices a stake nobody scheduled in proportion, not by a flat dollar cap', () => {
    // A fleet config or a direct writer can produce a stake the form never
    // offers. Before the ruling this took the tier's flat cap: $3 on a $0.07
    // big blind, 43 BB. It is held to the ladder now.
    const odd = getRakeConfig(0.07, 'nlh', 0.03);
    expect(findScheduleMatch(0.03, 0.07)).toBeNull();
    expect(odd.rakeCap / 0.07).toBeLessThanOrEqual(UNSCHEDULED_CAP_BB);
    expect(odd.rakeCap).toBe(1.05);
  });

  it('gives every offered stake a BBJ fee from the same tier scale', () => {
    for (const preset of BLINDS_PRESETS) {
      const { bbjFeeBB } = getRakeConfig(preset.bb, 'nlh', preset.sb);
      expect([0.6, 0.25, 0.12, 0.06, 0.03]).toContain(bbjFeeBB);
    }
  });

  it('moves no price except the two cheapest, and only downward', () => {
    // Measured against production before the change: of 972 cash tables, only
    // the two at 0.05/0.10 sit on a stake whose cap moves, $3 -> $1.50. Every
    // other live stake was already scheduled. No player pays more than before.
    const byLabel = (l: string) => BLINDS_PRESETS.find((p) => p.label === l)!;
    for (const [label, cap] of [
      ['0.25/0.50', 3],
      ['0.50/1', 5],
      ['1/2', 5],
      ['2/5', 7.5],
      ['5/10', 12.5],
      ['10/25', 15],
      ['25/50', 20],
    ] as const) {
      const p = byLabel(label);
      expect(getRakeConfig(p.bb, 'nlh', p.sb).rakeCap).toBe(cap);
    }
    const dflt = byLabel('0.05/0.10');
    expect(getRakeConfig(dflt.bb, 'nlh', dflt.sb).rakeCap).toBe(1.5);
  });

  it('has no 5/5 row - no legal table could ever match it', () => {
    // RAKE_SCHEDULE used to contain a 5/5 entry. The table-creation guard
    // refuses "big blind must exceed small blind", so no cash table could ever
    // match it and no hand was ever priced by it; it also sorted out of order
    // between 2/5 and 3/6, the tell of a typo placed by big blind. Dan ruled it
    // a typo on 2026-09-01: deleted, not legalised. bb == sb stays illegal.
    expect(findScheduleMatch(5, 5)).toBeNull();
    for (const row of RAKE_SCHEDULE) {
      expect(row.bb, `stake ${row.sb}/${row.bb} has bb <= sb`).toBeGreaterThan(row.sb);
    }
  });
});
