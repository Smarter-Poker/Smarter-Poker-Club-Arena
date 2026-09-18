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

function artIndex(segment: Pick<WheelSegment, 'kind' | 'game' | 'multiplier'>): number {
  if (segment.kind === 'bonus') {
    return { plinko: 0, crash: 1, crossing: 2, mines: 3 }[segment.game ?? 'plinko'];
  }
  if (segment.kind === 'upgrade') return 4;
  if (segment.kind === 'chips')
    return 4 + Math.min(3, Math.max(1, Math.trunc(segment.multiplier ?? 1)));
  if (segment.kind === 'throwables') return 8;
  if (segment.kind === 'time_bank') return 9;
  if (segment.kind === 'rabbit_hunt') return 10;
  return 11;
}

export function WheelPrizeArt({
  segment,
  className,
}: {
  segment: Pick<WheelSegment, 'kind' | 'game' | 'multiplier'>;
  className?: string;
}) {
  const region = regions[artIndex(segment)];
  return (
    <svg className={className} viewBox={region.join(' ')} aria-hidden="true" overflow="hidden">
      <image
        href={`${import.meta.env.BASE_URL}assets/diamond-spins/wheel-prize-atlas-v2.png`}
        width="1448"
        height="1086"
      />
    </svg>
  );
}
