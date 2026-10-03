import { describe, expect, it } from 'vitest';
import {
  binomialConfidence,
  formatRateEvidence,
  formatSampleEvidence,
} from '../../src/pages/stats/binomialConfidence';

describe('cash-stat confidence evidence', () => {
  it('computes a Wilson interval from the displayed rate and exact opportunities', () => {
    const interval = binomialConfidence(0.5, 100);

    expect(interval).not.toBeNull();
    expect(interval?.opportunities).toBe(100);
    expect(interval?.lowerPercent).toBeCloseTo(40.38, 2);
    expect(interval?.upperPercent).toBeCloseTo(59.62, 2);
    expect(formatRateEvidence(0.5, 100)).toBe('100 Opportunities · 95% Confidence 40.4% To 59.6%');
  });

  it('stays bounded for edge rates and uses the approved compact count convention', () => {
    const interval = binomialConfidence(1, 1_200);

    expect(interval?.lowerPercent).toBeGreaterThanOrEqual(0);
    expect(interval?.upperPercent).toBe(100);
    expect(formatRateEvidence(1, 1_200)).toMatch(/^1\.2K Opportunities/);
  });

  it('distinguishes an unavailable denominator from a measured zero-opportunity sample', () => {
    expect(formatRateEvidence(0.4, null, false)).toBe('Opportunity Denominator Unavailable');
    expect(formatRateEvidence(0, 0)).toBe('No Measured Opportunities');
    expect(binomialConfidence(Number.NaN, 10)).toBeNull();
    expect(formatSampleEvidence(1_200, 'Cash Hand')).toBe('1.2K Cash Hands');
    expect(formatSampleEvidence(null, 'Passive Action', 'Passive Actions', false)).toBe(
      'Passive Action Denominator Unavailable'
    );
  });
});
