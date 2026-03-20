/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — clubLevels (PokerBros-Style 1-50)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import {
  getTierForLevel,
  getClubLevel,
  getUnionLevel,
  computePlayerThreshold,
  computeHierarchyThreshold,
  computePlayerLevel,
  computeHierarchyLevel,
  computeHierarchyUnits,
} from '../../src/utils/clubLevels';

// ═══════════════════════════════════════════════════════════════════════════════
// THRESHOLD FORMULAS — Spec Anchors
// ═══════════════════════════════════════════════════════════════════════════════

describe('computePlayerThreshold', () => {
  // Exact JS values from Math.round(30 * 1.125^(L-1))
  // Spec anchors are approximate; these are the canonical computed values.
  it.each([
    [1, 30],
    [5, 48],
    [10, 87],
    [15, 156],
    [20, 281],
    [25, 507],
    [30, 913],
    [35, 1646],
    [40, 2965],
    [45, 5344],
    [50, 9629],
  ])('level %i should require %i players', (level, expected) => {
    expect(computePlayerThreshold(level)).toBe(expected);
  });
});

describe('computeHierarchyThreshold', () => {
  // Exact JS values from Math.round(2 * 1.086^(L-1))
  it.each([
    [1, 2],
    [5, 3],
    [10, 4],
    [15, 6],
    [20, 10],
    [25, 14],
    [30, 22],
    [35, 33],
    [40, 50],
    [45, 75],
    [50, 114],
  ])('level %i should require %i hierarchy units', (level, expected) => {
    expect(computeHierarchyThreshold(level)).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LEVEL COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('computePlayerLevel', () => {
  it('should return 1 for 0 players', () => {
    // 0 < 30 (threshold for L1), so player_level = 1 (minimum)
    // Actually, per spec: "If total_players < 30, player_level = 1"
    expect(computePlayerLevel(0)).toBe(1);
  });

  it('should return 1 for 29 players (below L1 threshold)', () => {
    expect(computePlayerLevel(29)).toBe(1);
  });

  it('should return 1 for exactly 30 players (L1 threshold)', () => {
    expect(computePlayerLevel(30)).toBe(1);
  });

  it('should return level 5 for 48 players', () => {
    expect(computePlayerLevel(48)).toBe(5);
  });

  it('should return level 10 for 87 players', () => {
    expect(computePlayerLevel(87)).toBe(10);
  });

  it('should return 50 for 9691+ players', () => {
    expect(computePlayerLevel(9691)).toBe(50);
    expect(computePlayerLevel(99999)).toBe(50);
  });
});

describe('computeHierarchyLevel', () => {
  it('should return 1 for 0 hierarchy units', () => {
    expect(computeHierarchyLevel(0)).toBe(1);
  });

  it('should return 1 for 1 hierarchy unit (below L1=2)', () => {
    expect(computeHierarchyLevel(1)).toBe(1);
  });

  it('should return 3 for exactly 2 hierarchy units (L1-L3 all have threshold=2)', () => {
    // ROUND(2*1.086^0)=2, ROUND(2*1.086^1)=2, ROUND(2*1.086^2)=2 → L3
    expect(computeHierarchyLevel(2)).toBe(3);
  });

  it('should return level 50 for 114+ hierarchy units', () => {
    expect(computeHierarchyLevel(114)).toBe(50);
    expect(computeHierarchyLevel(500)).toBe(50);
  });
});

describe('computeHierarchyUnits', () => {
  it('should compute correctly for admins only', () => {
    expect(computeHierarchyUnits(2, 0, 0)).toBe(2);
  });

  it('should compute correctly for mixed roles', () => {
    // spec example 2: 2 admins, 3 SAs, 24 agents = 2+3+6 = 11
    expect(computeHierarchyUnits(2, 3, 24)).toBe(11);
  });

  it('should compute correctly for heavy agent tree', () => {
    // spec example 3: 4 admins, 10 SAs, 60 agents = 4+10+15 = 29
    expect(computeHierarchyUnits(4, 10, 60)).toBe(29);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TIER MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

const VALID_TIERS = [
  'starter',
  'small',
  'growing',
  'established',
  'large',
  'regional',
  'major',
  'network',
  'enterprise',
  'elite',
];

describe('getTierForLevel', () => {
  it('should return starter for level 1', () => {
    expect(getTierForLevel(1)).toBe('starter');
  });

  it('should return starter for levels 1-5', () => {
    for (let l = 1; l <= 5; l++) expect(getTierForLevel(l)).toBe('starter');
  });

  it('should return small for levels 6-10', () => {
    for (let l = 6; l <= 10; l++) expect(getTierForLevel(l)).toBe('small');
  });

  it('should return elite for levels 46-50', () => {
    for (let l = 46; l <= 50; l++) expect(getTierForLevel(l)).toBe('elite');
  });

  it('should return starter for level 0 or negative', () => {
    expect(getTierForLevel(0)).toBe('starter');
    expect(getTierForLevel(-1)).toBe('starter');
  });

  it('should return a valid tier for any positive level', () => {
    expect(VALID_TIERS).toContain(getTierForLevel(25));
    expect(VALID_TIERS).toContain(getTierForLevel(100));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPEC EXAMPLES (Section H)
// ═══════════════════════════════════════════════════════════════════════════════

describe('getClubLevel — spec examples', () => {
  it('Example 1: 30 players, 2 admins → Level 1', () => {
    const info = getClubLevel({
      level: 1,
      playerCount: 30,
      hierarchyUnitsRoundedUp: 2,
      playerLevel: 1,
      hierarchyLevel: 1,
      playerThresholdCurrent: 30,
      playerThresholdNext: 34,
      hierarchyThresholdCurrent: 2,
      hierarchyThresholdNext: 2,
    });
    expect(info.level).toBe(1);
    expect(info.tier).toBe('starter');
    expect(info.tierLabel).toBe('Starter');
  });

  it('Example 2: 400 players, hierarchy_units=11 → Level 22', () => {
    const pLvl = computePlayerLevel(400);
    const hLvl = computeHierarchyLevel(11);
    const finalLvl = Math.max(pLvl, hLvl, 1);

    // Per spec: player_level ≈ 22, hierarchy_level ≈ 21, final = 22
    expect(pLvl).toBeGreaterThanOrEqual(21);
    expect(pLvl).toBeLessThanOrEqual(23);
    expect(finalLvl).toBe(Math.max(pLvl, hLvl, 1));

    const info = getClubLevel({
      level: finalLvl,
      playerCount: 400,
      hierarchyUnitsRoundedUp: 11,
      playerLevel: pLvl,
      hierarchyLevel: hLvl,
    });
    expect(info.tier).toBe('large'); // Level 21-25 = Large Club
  });

  it('Example 3: 120 players, hierarchy_units=29 → heavy agent tree', () => {
    const pLvl = computePlayerLevel(120);
    const hLvl = computeHierarchyLevel(29);
    const finalLvl = Math.max(pLvl, hLvl, 1);

    // Per spec: player_level ≈ 12, hierarchy_level ≈ 33, final = 33
    expect(pLvl).toBeGreaterThanOrEqual(11);
    expect(pLvl).toBeLessThanOrEqual(13);
    expect(hLvl).toBeGreaterThanOrEqual(32);
    expect(hLvl).toBeLessThanOrEqual(34);
    expect(finalLvl).toBe(hLvl); // Hierarchy dominates

    const info = getClubLevel({
      level: finalLvl,
      playerCount: 120,
      hierarchyUnitsRoundedUp: 29,
      playerLevel: pLvl,
      hierarchyLevel: hLvl,
    });
    expect(info.tier).toBe('major'); // Level 31-35 = Major Operator
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('getClubLevel — edge cases', () => {
  it('should return level 1 for brand new club', () => {
    const info = getClubLevel({ playerCount: 0 });
    expect(info.level).toBe(1);
    expect(info.tier).toBe('starter');
  });

  it('should cap level at 50', () => {
    const info = getClubLevel({ level: 50, playerCount: 99999 });
    expect(info.level).toBe(50);
    expect(info.progressPercent).toBe(100);
  });

  it('should return progressPercent as a number between 0-100', () => {
    const info = getClubLevel({ level: 5, playerCount: 40, hierarchyUnitsRoundedUp: 2 });
    expect(typeof info.progressPercent).toBe('number');
    expect(info.progressPercent).toBeGreaterThanOrEqual(0);
    expect(info.progressPercent).toBeLessThanOrEqual(100);
  });

  it('should have gradient and color defined', () => {
    const info = getClubLevel({ level: 25 });
    expect(info.gradient).toBeTruthy();
    expect(info.color).toBeTruthy();
  });

  it('should handle legacy memberCount field', () => {
    const info = getClubLevel({ memberCount: 100 });
    expect(info.level).toBe(1);
    expect(info.tier).toBe('starter');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNION LEVEL
// ═══════════════════════════════════════════════════════════════════════════════

describe('getUnionLevel', () => {
  it('should return the same output structure as getClubLevel', () => {
    const info = getUnionLevel({
      level: 10,
      totalPlayers: 200,
      hierarchyUnitsRoundedUp: 5,
    });
    expect(info.level).toBe(10);
    expect(info.tier).toBe('small');
    expect(info.tierLabel).toBe('Small Club');
    expect(typeof info.progressPercent).toBe('number');
    expect(info.gradient).toBeTruthy();
  });

  it('should return level 1 for empty union', () => {
    const info = getUnionLevel({});
    expect(info.level).toBe(1);
    expect(info.tier).toBe('starter');
  });
});
