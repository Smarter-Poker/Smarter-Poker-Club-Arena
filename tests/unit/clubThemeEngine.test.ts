/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — clubThemeEngine
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

// Mock localStorage
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
});

import { THEMES, getStoredThemeId, getTheme, useClubTheme } from '../../src/utils/clubThemeEngine';

describe('clubThemeEngine', () => {
  it('should export THEMES as an object', () => {
    expect(typeof THEMES).toBe('object');
    expect(Object.keys(THEMES).length).toBeGreaterThan(0);
  });

  it('should have required fields on each theme', () => {
    for (const [, theme] of Object.entries(THEMES)) {
      expect(typeof theme.id).toBe('string');
      expect(typeof theme.label).toBe('string');
      expect(typeof theme.primary).toBe('string');
    }
  });

  it('should export getStoredThemeId as a function', () => {
    expect(typeof getStoredThemeId).toBe('function');
  });

  it('should return a default theme for null club', () => {
    const id = getStoredThemeId(null);
    expect(typeof id).toBe('string');
  });

  it('should export getTheme as a function', () => {
    expect(typeof getTheme).toBe('function');
  });

  it('should return a theme for dark id', () => {
    const theme = getTheme('dark');
    expect(theme).toBeDefined();
    expect(typeof theme.label).toBe('string');
    expect(typeof theme.primary).toBe('string');
  });

  it('should export useClubTheme as a function', () => {
    expect(typeof useClubTheme).toBe('function');
  });
});
