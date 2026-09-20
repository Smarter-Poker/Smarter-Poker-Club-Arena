/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RAKE SCHEDULE ENFORCEMENT — does the engine actually apply the real schedule?
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS (2026-08-15)
 *
 * Every other server rake test — HandController.audit / basicplay / reopening /
 * bigblindante — constructs `rakeConfig: { percent: 5, cap: 100, noFlopNoDrop:
 * true }`. That is a SYNTHETIC config:
 *
 *   - 5% is not our rate. The published schedule is 10% at every stake.
 *   - cap: 100 NEVER BINDS. No pot in those tests approaches $100 of rake, so
 *     the cap branch of calculateRake is never executed.
 *
 * Those tests prove the MECHANICS (uncalled bets excluded from the raked pot,
 * no-flop-no-drop, chip conservation) and they prove them well. What nothing
 * proved is that the engine honours the ACTUAL published caps — the thing a
 * player is charged. A regression that silently raked $40 out of a 10/25 pot
 * capped at $15 would have passed the entire server suite.
 *
 * This file drives the real production path: getFullRakeConfig() -> the same
 * mapping ServerTableEngineBase performs -> calculateRake(). It is deliberately
 * built on pots big enough that the cap MUST bind.
 *
 * Completes the chain started on the client side the same day:
 *   tests/unit/RakeConfig.schedule.test.ts  — the client schedule is correct
 *   scripts/ci/check-rake-schedule-parity.mjs — client schedule == server schedule
 *   THIS FILE                                — the engine applies that schedule
 *
 * so what the Game Rules modal shows a player is provably what the engine takes.
 * That modal was misstating the rake as 5% / $3 cap until 2026-08-15.
 */

import { describe, it, expect } from 'vitest';
import { calculateRake } from './PokerEngine.js';
import { getFullRakeConfig, getPlayerCountCaps, RAKE_SCHEDULE } from '../config/RakeConfig.js';
import type { RakeConfig } from '../types.js';

/**
 * Build the rake config EXACTLY as ServerTableEngineBase.getRakeConfig() does
 * (server/src/engine/ServerTableEngineBase.ts). If that mapping changes and
 * this helper is not updated, these tests stop reflecting production — so keep
 * them in lockstep.
 */
function productionRakeConfig(
  sb: number,
  bb: number,
  variant = 'nlh',
  /** tables.max_players. Omitted = the nine-max ladder, as the engine reads it
      when a table row carries no usable seat count. */
  seats?: number
): RakeConfig {
  const full = getFullRakeConfig(sb, bb, variant);
  return {
    percent: full.rakePercent,
    cap: full.rakeCap,
    noFlopNoDrop: true,
    playerCountCaps: getPlayerCountCaps(full.rakeCap, seats),
  };
}

/** A pot far larger than any cap, so the cap branch must execute. */
const HUGE_POT = 100_000;

describe('rake schedule - the cap actually binds at every stake', () => {
  it.each(RAKE_SCHEDULE.map((r) => [r.sb, r.bb, r.rakeCap] as const))(
    '%s/%s: a %s-capped pot is capped, not raked at 10%%',
    (sb, bb, expectedCap) => {
      const cfg = productionRakeConfig(sb, bb);
      // 6-handed => full cap tier (4+ players).
      const rake = calculateRake(HUGE_POT, true, cfg, 6);
      expect(rake).toBe(expectedCap);
      // Sanity: uncapped 10% of this pot would be enormous. Prove the cap did work.
      expect(rake).toBeLessThan(HUGE_POT * 0.1);
    }
  );
});

describe('rake schedule - 10% applies below the cap', () => {
  it('1/2: a $20 pot is raked $2.00, well under the $5 cap', () => {
    const cfg = productionRakeConfig(1, 2);
    expect(cfg.percent).toBe(10);
    expect(cfg.cap).toBe(5);
    expect(calculateRake(20, true, cfg, 6)).toBe(2);
  });

  it('1/2: the cap takes over exactly at $50 of pot', () => {
    const cfg = productionRakeConfig(1, 2);
    // 10% of 50 = 5.00 = the cap. One cent more must not raise the rake.
    expect(calculateRake(50, true, cfg, 6)).toBe(5);
    expect(calculateRake(50.01, true, cfg, 6)).toBe(5);
    expect(calculateRake(500, true, cfg, 6)).toBe(5);
  });

  it('10/25: 10% applies below cap and $15 binds above it', () => {
    const cfg = productionRakeConfig(10, 25);
    expect(cfg.cap).toBe(15);
    expect(calculateRake(100, true, cfg, 6)).toBe(10);
    expect(calculateRake(150, true, cfg, 6)).toBe(15);
    expect(calculateRake(10_000, true, cfg, 6)).toBe(15);
  });
});

describe('rake schedule - no flop, no drop', () => {
  it.each(RAKE_SCHEDULE.map((r) => [r.sb, r.bb] as const))(
    '%s/%s: a pot that never saw a flop is raked zero',
    (sb, bb) => {
      const cfg = productionRakeConfig(sb, bb);
      expect(calculateRake(HUGE_POT, false, cfg, 6)).toBe(0);
    }
  );
});

describe('rake schedule - player-count cap reduction (Bible V8 §2.9)', () => {
  it('heads-up pays half the cap', () => {
    const cfg = productionRakeConfig(1, 2); // cap 5
    expect(calculateRake(HUGE_POT, true, cfg, 2)).toBe(2.5);
  });

  it('3-handed pays 75% of the cap on a nine-max table', () => {
    // Dan 2026-09-14 moved this rung from 67% to 75%.
    const cfg = productionRakeConfig(1, 2, 'nlh', 9); // cap 5 -> 3.75
    expect(calculateRake(HUGE_POT, true, cfg, 3)).toBe(3.75);
  });

  it('3-handed pays the FULL cap on a 6, 7 or 8-max table', () => {
    // Dan 2026-09-14: "ONCE ANY 6-8 HANDED GAME REACHES 3+ PLAYERS FULL RAKE
    // + BBJ IS APPLIED." The discount is a nine-max rule; on a short table
    // three players is most of a game, not a table that has emptied out.
    for (const seats of [6, 7, 8]) {
      const cfg = productionRakeConfig(1, 2, 'nlh', seats);
      expect(calculateRake(HUGE_POT, true, cfg, 3), `${seats}-max`).toBe(5);
    }
  });

  it('heads-up keeps half the cap at every table size', () => {
    // Only the three-handed rung is seat-gated. Two players is two players.
    for (const seats of [2, 6, 8, 9, undefined]) {
      const cfg = productionRakeConfig(1, 2, 'nlh', seats);
      expect(calculateRake(HUGE_POT, true, cfg, 2), `${seats}-max`).toBe(2.5);
    }
  });

  it('falls back to the nine-max ladder when the seat count is unusable', () => {
    // A table row that failed to load, or a 0/NaN max_players, must price a
    // pot as it was priced yesterday - never higher.
    for (const seats of [undefined, 0, Number.NaN]) {
      const cfg = productionRakeConfig(1, 2, 'nlh', seats);
      expect(calculateRake(HUGE_POT, true, cfg, 3), `seats=${seats}`).toBe(3.75);
    }
  });

  it('4+ handed pays the full cap', () => {
    const cfg = productionRakeConfig(1, 2);
    expect(calculateRake(HUGE_POT, true, cfg, 4)).toBe(5);
    expect(calculateRake(HUGE_POT, true, cfg, 9)).toBe(5);
  });

  it('a short-handed cap is never larger than the full cap, at any stake or table size', () => {
    for (const row of RAKE_SCHEDULE) {
      for (const seats of [undefined, 2, 6, 7, 8, 9, 10]) {
        const cfg = productionRakeConfig(row.sb, row.bb, 'nlh', seats);
        const hu = calculateRake(HUGE_POT, true, cfg, 2);
        const three = calculateRake(HUGE_POT, true, cfg, 3);
        const full = calculateRake(HUGE_POT, true, cfg, 6);
        expect(hu, `${row.sb}/${row.bb} ${seats}-max heads-up`).toBeLessThanOrEqual(full);
        expect(three, `${row.sb}/${row.bb} ${seats}-max 3-handed`).toBeLessThanOrEqual(full);
        expect(hu, `${row.sb}/${row.bb} ${seats}-max`).toBeLessThanOrEqual(three);
      }
    }
  });
});

describe('rake schedule - the engine never invents a rate', () => {
  it('charges 10%, not the 5% every other server test hardcodes', () => {
    for (const row of RAKE_SCHEDULE) {
      expect(productionRakeConfig(row.sb, row.bb).percent, `${row.sb}/${row.bb}`).toBe(10);
    }
  });

  it('an unlisted stake still yields a real cap rather than an unbounded rake', () => {
    // 7/14 is not on the schedule; tier fallback must still bound the rake.
    const cfg = productionRakeConfig(7, 14);
    expect(cfg.cap).toBeGreaterThan(0);
    expect(calculateRake(HUGE_POT, true, cfg, 6)).toBe(cfg.cap);
  });

  it('rake is never negative and never exceeds the pot', () => {
    for (const row of RAKE_SCHEDULE) {
      const cfg = productionRakeConfig(row.sb, row.bb);
      for (const pot of [0, 0.01, 1, 7.77, 250, HUGE_POT]) {
        const r = calculateRake(pot, true, cfg, 6);
        expect(r, `${row.sb}/${row.bb} pot ${pot}`).toBeGreaterThanOrEqual(0);
        expect(r, `${row.sb}/${row.bb} pot ${pot}`).toBeLessThanOrEqual(pot);
      }
    }
  });
});
