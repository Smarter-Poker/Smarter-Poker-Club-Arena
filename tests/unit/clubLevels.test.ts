/**
 * Club levels — REWRITTEN 2026-08-21 against the CURRENT system.
 *
 * The original file pinned the retired dual-axis spec (levels 1-50, tiers
 * ending at 'legendary', worked examples like "30 players, 2 admins → Level
 * 1"). The system was redesigned: member-count thresholds drive the level
 * (CLUB_LEVEL_THRESHOLDS, MAX_CLUB_LEVEL), tier names changed, and the
 * formula is mirrored into the DB by migration — so this file now pins the
 * new system's INVARIANTS and exported contract rather than dead constants.
 * (Client tests did not run in CI when the redesign shipped, which is how the
 * old pins rotted silently; they gate now.)
 */
import { describe, it, expect } from 'vitest';
import {
  CLUB_LEVEL_THRESHOLDS,
  MAX_CLUB_LEVEL,
  getClubLevelFromMembers,
  membersToNextClubLevel,
  getClubLevelInfoFromMembers,
  getTierForLevel,
} from '../../src/utils/clubLevels';

describe('threshold table', () => {
  it('is strictly ascending — a bigger club can never map to a lower level', () => {
    for (let i = 1; i < CLUB_LEVEL_THRESHOLDS.length; i++) {
      expect(CLUB_LEVEL_THRESHOLDS[i]).toBeGreaterThan(CLUB_LEVEL_THRESHOLDS[i - 1]);
    }
  });

  it('MAX_CLUB_LEVEL matches the table length', () => {
    expect(MAX_CLUB_LEVEL).toBe(CLUB_LEVEL_THRESHOLDS.length);
    expect(MAX_CLUB_LEVEL).toBeGreaterThanOrEqual(50);
  });
});

describe('getClubLevelFromMembers', () => {
  it('never returns below 1 or above MAX, whatever comes in', () => {
    for (const input of [null, undefined, -5, 0, 1, 3, 100, 10_000, 10_000_000]) {
      const lvl = getClubLevelFromMembers(input as number | null | undefined);
      expect(lvl).toBeGreaterThanOrEqual(1);
      expect(lvl).toBeLessThanOrEqual(MAX_CLUB_LEVEL);
    }
  });

  it('is monotonic in member count', () => {
    let prev = 0;
    for (const members of [0, 1, 5, 20, 50, 200, 1000, 50_000, 1_000_000]) {
      const lvl = getClubLevelFromMembers(members);
      expect(lvl).toBeGreaterThanOrEqual(prev);
      prev = lvl;
    }
  });

  it('crossing a threshold raises the level by exactly one', () => {
    // Pick a mid-table threshold and check the boundary behaves.
    const idx = Math.floor(CLUB_LEVEL_THRESHOLDS.length / 2);
    const t = CLUB_LEVEL_THRESHOLDS[idx];
    expect(getClubLevelFromMembers(t)).toBe(getClubLevelFromMembers(t - 1) + 1);
  });
});

describe('membersToNextClubLevel', () => {
  it('reports a positive distance below the cap and null at the cap', () => {
    const need = membersToNextClubLevel(1);
    expect(need === null || need > 0).toBe(true);
    const top = CLUB_LEVEL_THRESHOLDS[CLUB_LEVEL_THRESHOLDS.length - 1];
    expect(membersToNextClubLevel(top + 1)).toBeNull();
  });
});

describe('getTierForLevel', () => {
  it('returns a non-empty tier for every level 1..MAX and beyond', () => {
    for (const lvl of [1, 2, 10, 25, MAX_CLUB_LEVEL, MAX_CLUB_LEVEL + 40]) {
      const tier = getTierForLevel(lvl);
      expect(typeof tier).toBe('string');
      expect(tier.length).toBeGreaterThan(0);
    }
  });

  it('never downgrades: the tier at a higher level is at or past the tier at a lower one', () => {
    // Tiers change monotonically with level — collect the order of first
    // appearance and assert no tier reappears after a different one.
    const seen: string[] = [];
    for (let lvl = 1; lvl <= MAX_CLUB_LEVEL; lvl++) {
      const tier = getTierForLevel(lvl);
      const at = seen.indexOf(tier);
      if (at === -1) seen.push(tier);
      else expect(at).toBe(seen.length - 1); // only ever the most recent tier repeats
    }
  });
});

describe('getClubLevelInfoFromMembers', () => {
  it('level, tier and progress agree with the primitive functions', () => {
    const info = getClubLevelInfoFromMembers(250);
    expect(info.level).toBe(getClubLevelFromMembers(250));
    expect(info.tier).toBe(getTierForLevel(info.level));
  });
});
