// This route already treats 500 hands in a position and 1,000 cash hands in
// total as the minimum meaningful comparison. Two qualifying positions imply
// the same 1,000-hand floor, so the headline cannot outrun the route's own
// sample-confidence warning.
export const POSITION_CALLOUT_MIN_HANDS = 500;
export const POSITION_NEUTRAL_COLOR = 'var(--text-secondary)';

export interface PositionCalloutCandidate {
  position: string;
  handsPlayed: number;
  winRate: number | null;
}

export interface PositionCalloutSelection<T extends PositionCalloutCandidate> {
  strongest: (T & { winRate: number }) | null;
  weakest: (T & { winRate: number }) | null;
  eligibleCount: number;
}

export function positionTrendLabel(winRate: number | null, handsPlayed: number): string {
  if (winRate === null) return 'Not Measured';
  if (handsPlayed < POSITION_CALLOUT_MIN_HANDS) return 'Building Sample';
  if (winRate > 3) return 'Exceptional';
  if (winRate > 1.5) return 'Strong';
  if (winRate >= 0) return 'Neutral';
  return 'Losing';
}

export function positionRateColor(winRate: number | null, handsPlayed: number): string {
  if (winRate === null || handsPlayed < POSITION_CALLOUT_MIN_HANDS) {
    return POSITION_NEUTRAL_COLOR;
  }
  if (winRate > 4) return 'var(--accent-green)';
  if (winRate > 2) return 'var(--accent-cyan)';
  if (winRate >= 0) return 'var(--accent-orange)';
  return 'var(--accent-red)';
}

export function positionProgressPercent(winRate: number | null, handsPlayed: number): number {
  if (winRate === null || handsPlayed < POSITION_CALLOUT_MIN_HANDS) return 0;
  return Math.min(100, Math.max(0, (winRate / 5.5) * 100));
}

/**
 * Rank only readable, known-position samples. A single qualifying position is
 * not a comparison, so callers receive null rankings until two are available.
 */
export function selectPositionCallouts<T extends PositionCalloutCandidate>(
  positions: readonly T[]
): PositionCalloutSelection<T> {
  const eligible = positions.filter(
    (row) =>
      row.position.trim().length > 0 &&
      row.position.trim().toUpperCase() !== 'UNK' &&
      Number.isFinite(row.handsPlayed) &&
      row.handsPlayed >= POSITION_CALLOUT_MIN_HANDS &&
      typeof row.winRate === 'number' &&
      Number.isFinite(row.winRate)
  ) as Array<T & { winRate: number }>;

  if (eligible.length < 2) {
    return { strongest: null, weakest: null, eligibleCount: eligible.length };
  }

  return {
    strongest: eligible.reduce((best, row) => (row.winRate > best.winRate ? row : best)),
    weakest: eligible.reduce((worst, row) => (row.winRate < worst.winRate ? row : worst)),
    eligibleCount: eligible.length,
  };
}
