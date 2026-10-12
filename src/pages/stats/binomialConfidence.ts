import { compactChips } from '../../utils/format';

export interface BinomialConfidence {
  lowerPercent: number;
  upperPercent: number;
  opportunities: number;
}

/**
 * A 95% Wilson score interval for a measured rate.
 *
 * Stats RPCs return rounded rates plus the exact opportunity denominator. The
 * Wilson interval uses those two values directly, remains useful at 0%/100%,
 * and does not invent an arbitrary "good sample" threshold.
 */
export function binomialConfidence(
  rate: number,
  opportunities: number | null | undefined
): BinomialConfidence | null {
  const n = Math.floor(opportunities ?? 0);
  if (!Number.isFinite(rate) || !Number.isFinite(n) || n <= 0) return null;

  const p = Math.min(1, Math.max(0, rate));
  const z = 1.959963984540054;
  const zSquared = z * z;
  const denominator = 1 + zSquared / n;
  const centre = (p + zSquared / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + zSquared / (4 * n)) / n)) / denominator;

  return {
    lowerPercent: Math.max(0, centre - margin) * 100,
    upperPercent: Math.min(1, centre + margin) * 100,
    opportunities: n,
  };
}

export function formatRateEvidence(
  rate: number,
  opportunities: number | null | undefined,
  available = true
): string {
  if (!available) return 'Opportunity Denominator Unavailable';
  const confidence = binomialConfidence(rate, opportunities);
  if (!confidence) return 'No Measured Opportunities';

  const noun = confidence.opportunities === 1 ? 'Opportunity' : 'Opportunities';
  return `${compactChips(confidence.opportunities)} ${noun} · 95% Confidence ${confidence.lowerPercent.toFixed(1)}% To ${confidence.upperPercent.toFixed(1)}%`;
}

export function formatSampleEvidence(
  count: number | null | undefined,
  singular: string,
  plural = `${singular}s`,
  available = true
): string {
  if (!available) return `${singular} Denominator Unavailable`;
  const measured = Math.max(0, Math.floor(count ?? 0));
  return `${compactChips(measured)} ${measured === 1 ? singular : plural}`;
}
