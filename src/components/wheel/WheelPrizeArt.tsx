import type { WheelSegment } from '../../services/DiamondWheelService';

// Measured individual transparent objects in the source atlas. The source image
// stays intact; each SVG viewport exposes only its own dimensional prize render.
const regions = [
  [20, 70, 330, 325],
  [392, 80, 322, 320],
  [741, 53, 330, 348],
  [1087, 75, 345, 323],
  [33, 416, 312, 289],
  [397, 445, 301, 246],
  [751, 425, 304, 276],
  [1088, 415, 328, 289],
  [15, 728, 340, 336],
  [403, 708, 307, 357],
  [750, 706, 325, 374],
  [1089, 710, 346, 365],
] as const;

/**
 * The chip-stack art for an instant chip win: one stack up to 1x (including
 * the VIP 0.2x, 0.25x and 0.3x wins of the v4 wheel), two stacks from 2x,
 * three from 3x. A missing or unreadable multiplier is the single stack. The
 * wheel's sector cards (WheelPrizeCard) choose from the same rule.
 */
export function chipStackCard(multiplier: number | null | undefined): 1 | 2 | 3 {
  const m = Number(multiplier);
  if (!Number.isFinite(m)) return 1;
  return m >= 3 ? 3 : m >= 2 ? 2 : 1;
}

/** Art follows the prize's kind, never the ord it sits on. */
function artIndex(segment: Pick<WheelSegment, 'kind' | 'game' | 'multiplier'>): number {
  if (segment.kind === 'bonus') {
    return { plinko: 0, crash: 1, crossing: 2, mines: 3 }[segment.game ?? 'plinko'] ?? 0;
  }
  if (segment.kind === 'upgrade') return 4;
  if (segment.kind === 'chips') return 4 + chipStackCard(segment.multiplier);
  if (segment.kind === 'throwables') return 8;
  if (segment.kind === 'time_bank') return 9;
  if (segment.kind === 'rabbit_hunt') return 10;
  return 11;
}

/**
 * Throwables are a set, so the prize is shown as the set: the approved
 * combination cutout (boxing glove, water gun, egg, tomato, snowball), not the
 * atlas's single tomato tile (owner ruling 2026-09-21, R4). The file is the
 * marketplace master right-sized for this art by scripts/generate-webp-media.mjs.
 */
export const THROWABLES_PRIZE_ART = 'wheel-prize-throwables-v1.webp';

export function WheelPrizeArt({
  segment,
  className,
}: {
  segment: Pick<WheelSegment, 'kind' | 'game' | 'multiplier'>;
  className?: string;
}) {
  if (segment.kind === 'throwables')
    return (
      <svg
        className={className}
        viewBox="0 0 640 640"
        aria-hidden="true"
        overflow="hidden"
        data-prize-art="throwables"
      >
        <image
          href={`${import.meta.env.BASE_URL}assets/diamond-spins/${THROWABLES_PRIZE_ART}`}
          width="640"
          height="640"
        />
      </svg>
    );
  const region = regions[artIndex(segment)];
  return (
    <svg className={className} viewBox={region.join(' ')} aria-hidden="true" overflow="hidden">
      <image
        href={`${import.meta.env.BASE_URL}assets/diamond-spins/wheel-prize-atlas-v2.webp`}
        width="1448"
        height="1086"
      />
    </svg>
  );
}
