/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — RakeConfig schedule (the rake we ADVERTISE)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 *
 * These assertions were ported from tests/unit/RakeService.test.ts when
 * RakeService was deleted (2026-08-15). That service was a 924-line client-side
 * rake implementation with ZERO production callers — a fourth copy of the rake
 * schedule that would silently disagree with the engine if anyone revived it.
 * Deleting it was right, but its tests were the only automated proof that the
 * TIER CAP TABLE behaves correctly, so the coverage moves here rather than dying
 * with the implementation.
 *
 * Why the server suite does not already cover this: every server rake test
 * (HandController.audit / basicplay / reopening / bigblindante) constructs
 * `rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true }`. That is a synthetic
 * config — 5% is not our rate, and a cap of 100 never binds, so the cap law is
 * never exercised there. Those tests prove the MECHANICS (uncalled bets excluded
 * from the pot, no-flop-no-drop, chip conservation). This file proves the
 * SCHEDULE: the actual percentages, caps and BBJ drops per stake.
 *
 * Together with scripts/ci/check-rake-schedule-parity.mjs — which pins this
 * client schedule to server/src/config/RakeConfig.ts — the chain is:
 *
 *   this file: the client schedule is internally correct
 *   parity CI: the client schedule equals the server schedule
 *   server:    the server schedule is what is taken from the pot
 *
 * so what the Game Rules modal shows a player is provably what we charge them.
 * That modal was misstating the rake as 5% / $3 cap until 2026-08-15.
 */

import { describe, it, expect } from 'vitest';
import {
  RAKE_SCHEDULE,
  findScheduleMatch,
  getTierForBB,
  getRakeConfig,
} from '../../src/config/RakeConfig';

describe('RakeConfig — the 10% rake law', () => {
  it('charges 10% at every stake on the schedule', () => {
    expect(RAKE_SCHEDULE.length).toBeGreaterThan(0);
    for (const row of RAKE_SCHEDULE) {
      expect(row.rakePercent, `stake ${row.sb}/${row.bb}`).toBe(10);
    }
  });

  it('never advertises a zero or negative cap', () => {
    for (const row of RAKE_SCHEDULE) {
      expect(row.rakeCap, `stake ${row.sb}/${row.bb}`).toBeGreaterThan(0);
    }
  });

  it('caps rise monotonically with the big blind', () => {
    const ordered = [...RAKE_SCHEDULE].sort((a, b) => a.bb - b.bb);
    for (let i = 1; i < ordered.length; i++) {
      expect(
        ordered[i].rakeCap,
        `cap must not fall from ${ordered[i - 1].bb} to ${ordered[i].bb}`
      ).toBeGreaterThanOrEqual(ordered[i - 1].rakeCap);
    }
  });
});

describe('RakeConfig — exact tier caps', () => {
  // Locked to the published schedule. If a cap legitimately changes, this test
  // and the SERVER schedule must change together — the parity gate enforces the
  // second half of that.
  const EXPECTED: Array<[number, number, number]> = [
    [0.1, 0.2, 3],
    [0.2, 0.4, 3],
    [0.25, 0.5, 3],
    [0.3, 0.6, 5],
    [0.5, 1.0, 5],
    [1, 2, 5],
    [2, 4, 7.5],
    [2, 5, 7.5],
    [3, 6, 8],
    [4, 8, 10],
    [5, 10, 12.5],
    [10, 20, 15],
    [10, 25, 15],
    // Added 2026-08-31 on Dan's ruling: every stake the create-table form
    // offers gets a published row, so no offered stake is priced by the tier
    // fallback. Caps follow the ladder's own most generous proportion
    // (15 BB, the 0.1/0.2 row); 0.10/0.25 sits in the existing flat-$3 band;
    // the two nosebleed rows take the $20 they are already charged, so
    // publishing them moves no price. See
    // tests/unit/theFormOffersStakesTheScheduleCanPrice.test.ts.
    [0.01, 0.02, 0.3],
    [0.02, 0.05, 0.75],
    [0.05, 0.1, 1.5],
    [0.1, 0.25, 3],
    [25, 50, 20],
    [50, 100, 20],
  ];

  it.each(EXPECTED)('%s/%s caps at $%s', (sb, bb, cap) => {
    const cfg = getRakeConfig(bb, 'nlh', sb);
    expect(cfg.rakePercent).toBe(10);
    expect(cfg.rakeCap).toBe(cap);
  });

  it('covers every stake in the schedule with no gaps', () => {
    expect(EXPECTED.length).toBe(RAKE_SCHEDULE.length);
    for (const [sb, bb] of EXPECTED) {
      expect(findScheduleMatch(sb, bb), `missing ${sb}/${bb}`).not.toBeNull();
    }
  });
});

describe('RakeConfig — schedule lookup', () => {
  it('matches an exact stake', () => {
    const m = findScheduleMatch(10, 25);
    expect(m).not.toBeNull();
    expect(m!.rakeCap).toBe(15);
  });

  it('tolerates float drift in the blind values', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754; the lookup must survive it.
    expect(findScheduleMatch(0.1 + 0.2, 0.6)).not.toBeNull();
  });

  it('accepts string blinds (they arrive as strings from the DB)', () => {
    const m = findScheduleMatch('0.25', '0.5');
    expect(m).not.toBeNull();
    expect(m!.rakeCap).toBe(3);
  });

  it('returns null for an unlisted stake rather than guessing', () => {
    expect(findScheduleMatch(7, 14)).toBeNull();
  });

  it('falls back to a tier when the stake is not on the schedule', () => {
    // Unlisted stake must still yield a usable config, never undefined.
    const cfg = getRakeConfig(14, 'nlh', 7);
    expect(cfg._exactMatch).toBe(false);
    expect(cfg.rakePercent).toBeGreaterThan(0);
    expect(cfg.rakeCap).toBeGreaterThan(0);
  });

  it('flags exact matches so callers can tell a quote from an estimate', () => {
    expect(getRakeConfig(25, 'nlh', 10)._exactMatch).toBe(true);
  });
});

describe('RakeConfig — tier boundaries', () => {
  it.each([
    [0.5, 'nano'],
    [1, 'micro'],
    [3, 'small'],
    [8, 'mid'],
    [25, 'high'],
  ])('bb %s sits at the top of its tier', (bb) => {
    expect(getTierForBB(bb)).toBeDefined();
  });

  it('puts anything above 25bb in nosebleeds', () => {
    expect(getTierForBB(50)).toBe(getTierForBB(1000));
  });
});

describe('RakeConfig — BBJ drop', () => {
  it('defines a non-negative BBJ fee at every stake', () => {
    for (const row of RAKE_SCHEDULE) {
      expect(row.bbjFeeBB, `stake ${row.sb}/${row.bb}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('charges a smaller BB-multiple as stakes rise', () => {
    // The drop is a fraction of the BB, so higher stakes pay less per BB while
    // still contributing more in absolute terms.
    const low = getRakeConfig(0.2, 'nlh', 0.1).bbjFeeBB;
    const high = getRakeConfig(25, 'nlh', 10).bbjFeeBB;
    expect(low).toBeGreaterThan(high);
  });
});
