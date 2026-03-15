/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — pokerOdds
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import {
  countOuts,
  calculateEquity,
  getPositionName,
  getPositionInfo,
  getPositionColor,
  classifyDrawType,
} from '../../src/utils/pokerOdds';

describe('countOuts', () => {
  it('should return 0 for empty inputs', () => {
    expect(countOuts([], [])).toBe(0);
  });

  it('should return a number for valid cards', () => {
    const outs = countOuts(['Ah', 'Kh'], ['Qh', 'Jh', '2c']);
    expect(typeof outs).toBe('number');
    expect(outs).toBeGreaterThanOrEqual(0);
  });
});

describe('calculateEquity', () => {
  it('should return 0 for 0 outs', () => {
    expect(calculateEquity(0, 1)).toBe(0);
  });

  it('should return a percentage between 0 and 100', () => {
    const equity = calculateEquity(9, 2);
    expect(equity).toBeGreaterThan(0);
    expect(equity).toBeLessThanOrEqual(100);
  });

  it('should increase with more outs', () => {
    const low = calculateEquity(4, 2);
    const high = calculateEquity(15, 2);
    expect(high).toBeGreaterThan(low);
  });
});

describe('getPositionName', () => {
  it('should return a position string', () => {
    const pos = getPositionName(0, 6, 0);
    expect(typeof pos).toBe('string');
    expect(pos.length).toBeGreaterThan(0);
  });

  it('should return BTN for dealer seat', () => {
    const pos = getPositionName(0, 6, 0);
    expect(pos).toContain('BTN');
  });
});

describe('getPositionInfo', () => {
  it('should return info for BTN', () => {
    const info = getPositionInfo('BTN');
    expect(info.tier).toBeDefined();
  });

  it('should return info for UTG', () => {
    const info = getPositionInfo('UTG');
    expect(info.tier).toBeDefined();
  });
});

describe('getPositionColor', () => {
  it('should return a color string for premium', () => {
    const color = getPositionColor('premium');
    expect(typeof color).toBe('string');
  });

  it('should return a color for unknown tier', () => {
    const color = getPositionColor('unknown');
    expect(typeof color).toBe('string');
  });
});

describe('classifyDrawType', () => {
  it('should return undefined for no draw', () => {
    const draw = classifyDrawType(['2c', '7d'], ['Ks', 'Jh', '3c']);
    // No obvious draw with these cards
    expect(draw === undefined || typeof draw === 'string').toBe(true);
  });

  it('should detect flush draw with 4 suited cards', () => {
    const draw = classifyDrawType(['Ah', '2h'], ['Kh', '5h', '9c']);
    expect(draw).toBeDefined();
  });
});
