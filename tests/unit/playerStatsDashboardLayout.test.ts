import { describe, expect, it } from 'vitest';
import {
  normalizeDashboardLayout,
  type StatCategory,
} from '../../src/pages/stats/playerStatsPageModel';

const available: StatCategory[] = [
  'overview',
  'performance',
  'positions',
  'hands',
  'tournaments',
  'analysis',
  'trophies',
  'rake',
  'workspace',
];

describe('Stats dashboard layout normalization', () => {
  it('treats a saved subset as order only and appends every omitted feature', () => {
    expect(normalizeDashboardLayout(['performance', 'hands'], available)).toEqual([
      'performance',
      'hands',
      'overview',
      'positions',
      'tournaments',
      'analysis',
      'trophies',
      'rake',
      'workspace',
    ]);
  });

  it('drops garbage, non-strings, duplicates and input workspace', () => {
    const result = normalizeDashboardLayout(
      ['garbage', 'analysis', 3, 'analysis', 'workspace'],
      available
    );
    expect(result[0]).toBe('analysis');
    expect(result.filter((tab) => tab === 'analysis')).toHaveLength(1);
    expect(result.at(-1)).toBe('workspace');
    expect(result).not.toContain('garbage');
  });

  it('never restores unavailable tabs and preserves the default order for empty input', () => {
    const withoutRake = available.filter((tab) => tab !== 'rake');
    expect(normalizeDashboardLayout(['rake'], withoutRake)).toEqual(withoutRake);
    expect(normalizeDashboardLayout([], available)).toEqual(available);
  });

  it('treats non-array legacy JSON as an empty saved order', () => {
    expect(normalizeDashboardLayout(null, available)).toEqual(available);
    expect(normalizeDashboardLayout({ overview: true }, available)).toEqual(available);
  });
});
