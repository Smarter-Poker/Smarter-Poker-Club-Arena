/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🛠️ UTILS — Unit Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Updated to match the EXACT-PRECISION formatting directive:
 * - formatCurrency: comma-separated, 2 decimal places, NO $ prefix
 * - formatChips: comma-separated, 2 decimal places, NO K/M abbreviations
 * - formatStakes: uses formatChipsWhole (integer display for blinds)
 * - calculatePotOdds: uses toBeCloseTo for floating-point safety
 */

import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatChips,
  formatPercent,
  formatRelativeTime,
  formatDuration,
  truncate,
  capitalize,
  titleCase,
  slugify,
  formatStakes,
  calculatePotOdds,
  isValidEmail,
  isValidUsername,
  shuffle,
  unique,
  groupBy,
  generateId,
  randomInRange,
} from '../src/lib/utils';

// ═══════════════════════════════════════════════════════════════════════════════
// NUMBER FORMATTING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatCurrency', () => {
  it('should format with exact precision (no $ prefix, 2 decimals)', () => {
    expect(formatCurrency(1000)).toBe('1,000.00');
    expect(formatCurrency(99.99)).toBe('99.99');
    expect(formatCurrency(0)).toBe('0.00');
  });
});

describe('formatChips', () => {
  it('should format large numbers with exact precision (no K/M abbreviations)', () => {
    expect(formatChips(1500000)).toBe('1,500,000.00');
    expect(formatChips(2000000)).toBe('2,000,000.00');
  });

  it('should format thousands with exact precision', () => {
    expect(formatChips(15000)).toBe('15,000.00');
    expect(formatChips(5500)).toBe('5,500.00');
  });

  it('should format small numbers with 2 decimal places', () => {
    expect(formatChips(500)).toBe('500.00');
    expect(formatChips(0)).toBe('0.00');
  });

  it('should preserve decimal precision', () => {
    expect(formatChips(1286.5)).toBe('1,286.50');
    expect(formatChips(0.75)).toBe('0.75');
  });
});

describe('formatPercent', () => {
  it('should format percentages correctly', () => {
    expect(formatPercent(50.5)).toBe('50.5%');
    expect(formatPercent(100)).toBe('100.0%');
    expect(formatPercent(33.333, 2)).toBe('33.33%');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATE/TIME FORMATTING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatDuration', () => {
  it('should format hours, minutes, seconds', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(45)).toBe('0:45');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STRING UTILITY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('truncate', () => {
  it('should truncate long strings', () => {
    expect(truncate('Hello World', 5)).toBe('Hello...');
    expect(truncate('Short', 10)).toBe('Short');
  });
});

describe('capitalize', () => {
  it('should capitalize first letter', () => {
    expect(capitalize('hello')).toBe('Hello');
    expect(capitalize('WORLD')).toBe('World');
  });
});

describe('titleCase', () => {
  it('should convert to title case', () => {
    expect(titleCase('hello world')).toBe('Hello World');
    expect(titleCase('the quick brown fox')).toBe('The Quick Brown Fox');
  });
});

describe('slugify', () => {
  it('should create URL-safe slugs', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('Poker Tournament!')).toBe('poker-tournament');
    expect(slugify('  Multiple  Spaces  ')).toBe('multiple-spaces');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POKER UTILITY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatStakes', () => {
  it('should format stakes using whole-chip display', () => {
    expect(formatStakes(1, 2)).toBe('1/2');
    expect(formatStakes(5, 10)).toBe('5/10');
    expect(formatStakes(1000, 2000)).toBe('1,000/2,000');
  });
});

describe('calculatePotOdds', () => {
  it('should calculate pot odds correctly', () => {
    // 50 / (100 + 50) * 100 = 33.333...%
    expect(calculatePotOdds(100, 50)).toBeCloseTo(100 / 3, 10);
    expect(calculatePotOdds(100, 0)).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('isValidEmail', () => {
  it('should validate email addresses', () => {
    expect(isValidEmail('test@example.com')).toBe(true);
    expect(isValidEmail('user.name@domain.org')).toBe(true);
    expect(isValidEmail('invalid')).toBe(false);
    expect(isValidEmail('missing@')).toBe(false);
    expect(isValidEmail('@nodomain.com')).toBe(false);
  });
});

describe('isValidUsername', () => {
  it('should validate usernames', () => {
    expect(isValidUsername('player123')).toBe(true);
    expect(isValidUsername('cool_user')).toBe(true);
    expect(isValidUsername('ab')).toBe(false); // too short
    expect(isValidUsername('has spaces')).toBe(false);
    expect(isValidUsername('special@char')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARRAY UTILITY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('shuffle', () => {
  it('should return array of same length', () => {
    const arr = [1, 2, 3, 4, 5];
    const shuffled = shuffle(arr);
    expect(shuffled.length).toBe(arr.length);
    expect(shuffled.sort()).toEqual(arr.sort());
  });

  it('should not mutate original array', () => {
    const arr = [1, 2, 3, 4, 5];
    const original = [...arr];
    shuffle(arr);
    expect(arr).toEqual(original);
  });
});

describe('unique', () => {
  it('should remove duplicates', () => {
    expect(unique([1, 2, 2, 3, 3, 3])).toEqual([1, 2, 3]);
    expect(unique(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });
});

describe('groupBy', () => {
  it('should group by key', () => {
    const items = [
      { type: 'a', value: 1 },
      { type: 'b', value: 2 },
      { type: 'a', value: 3 },
    ];
    const grouped = groupBy(items, 'type');
    expect(grouped['a'].length).toBe(2);
    expect(grouped['b'].length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RANDOM UTILITY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateId', () => {
  it('should generate ID of correct length', () => {
    expect(generateId().length).toBe(8);
    expect(generateId(12).length).toBe(12);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('randomInRange', () => {
  it('should return number in range', () => {
    for (let i = 0; i < 100; i++) {
      const num = randomInRange(5, 10);
      expect(num).toBeGreaterThanOrEqual(5);
      expect(num).toBeLessThanOrEqual(10);
    }
  });
});
