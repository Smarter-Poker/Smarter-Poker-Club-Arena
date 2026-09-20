/**
 * The arithmetic behind "Where Your Diamonds Go": which lines carry diamonds
 * in the chosen window, and each line's share of its side. Pure, so the
 * panel's tests can pin it without rendering. DIAMONDS ONLY.
 */
import type { DiamondFlowLine } from '../../services/DiamondService';

export type DiamondFlowSpan = 'lifetime' | 'last30';

export const amountIn = (line: DiamondFlowLine, span: DiamondFlowSpan) =>
  span === 'lifetime' ? line.lifetime : line.last30;

export const countIn = (line: DiamondFlowLine, span: DiamondFlowSpan) =>
  span === 'lifetime' ? line.lifetimeCount : line.last30Count;

/** The lines that carry diamonds in the chosen span, largest first. */
export function linesFor(lines: DiamondFlowLine[], span: DiamondFlowSpan): DiamondFlowLine[] {
  return lines
    .filter((l) => amountIn(l, span) > 0)
    .sort((a, b) => amountIn(b, span) - amountIn(a, span) || a.bucket.localeCompare(b.bucket));
}

/** Share of the side's total, 0-100, for the bar behind a line. */
export function shareOf(line: DiamondFlowLine, total: number, span: DiamondFlowSpan): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, (amountIn(line, span) / total) * 100));
}
