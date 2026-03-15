/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — clubLevels
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { getTierForLevel, getClubLevel } from '../../src/utils/clubLevels';

describe('getTierForLevel', () => {
  it('should return bronze for level 1', () => {
    expect(getTierForLevel(1)).toBe('bronze');
  });

  it('should return a valid tier for level 5', () => {
    const tier = getTierForLevel(5);
    expect(['bronze', 'silver', 'gold', 'platinum', 'diamond', 'elite', 'legendary']).toContain(
      tier
    );
  });

  it('should return highest tier for very high level', () => {
    const tier = getTierForLevel(100);
    expect(tier).toBeDefined();
  });

  it('should return bronze for level 0 or negative', () => {
    expect(getTierForLevel(0)).toBe('bronze');
    expect(getTierForLevel(-1)).toBe('bronze');
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

  it('should increase level with more activity', () => {
    const low = getClubLevel({ members: 5, tables: 1, totalHands: 50 });
    const high = getClubLevel({ members: 100, tables: 20, totalHands: 10000 });
    expect(high.level).toBeGreaterThanOrEqual(low.level);
  });

  it('should return xp and nextLevelXp', () => {
    const info = getClubLevel({ members: 10, tables: 2, totalHands: 100 });
    expect(typeof info.xp).toBe('number');
    expect(typeof info.nextLevelXp).toBe('number');
  });
});
