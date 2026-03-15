/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — clubLevels
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { getTierForLevel, getClubLevel } from '../../src/utils/clubLevels';

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

  it('should return a valid tier for level 5', () => {
    const tier = getTierForLevel(5);
    expect(VALID_TIERS).toContain(tier);
  });

  it('should return a valid tier for very high level', () => {
    const tier = getTierForLevel(100);
    expect(VALID_TIERS).toContain(tier);
  });

  it('should return starter for level 0 or negative', () => {
    expect(getTierForLevel(0)).toBe('starter');
    expect(getTierForLevel(-1)).toBe('starter');
  });
});

describe('getClubLevel', () => {
  it('should return a ClubLevelInfo for basic input', () => {
    const info = getClubLevel({ members: 10, tables: 2, totalHands: 100 });
    expect(info).toBeDefined();
    expect(typeof info.level).toBe('number');
    expect(typeof info.tier).toBe('string');
  });

  it('should return level 1 for brand new club', () => {
    const info = getClubLevel({ members: 0, tables: 0, totalHands: 0 });
    expect(info.level).toBe(1);
  });

  it('should return a valid tier', () => {
    const info = getClubLevel({ members: 50, tables: 10, totalHands: 5000 });
    expect(VALID_TIERS).toContain(info.tier);
  });

  it('should return progressPercent as a number', () => {
    const info = getClubLevel({ members: 10, tables: 2, totalHands: 100 });
    expect(typeof info.progressPercent).toBe('number');
  });
});
