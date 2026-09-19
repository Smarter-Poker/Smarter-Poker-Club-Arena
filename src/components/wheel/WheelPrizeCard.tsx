import { useId, useMemo } from 'react';
import type { WheelSegment } from '../../services/DiamondWheelService';
import styles from './WheelPrizeCard.module.css';

type Region = readonly [number, number, number, number];
const MAIN_REGIONS: readonly Region[] = [
  [12, 55, 344, 328],
  [367, 55, 351, 328],
  [727, 55, 350, 328],
  [1083, 55, 353, 328],
  [12, 389, 344, 327],
  [367, 389, 351, 327],
  [727, 389, 350, 327],
  [1083, 389, 353, 327],
  [12, 718, 344, 334],
  [367, 718, 351, 334],
  [727, 718, 350, 334],
  [1083, 718, 353, 334],
];
const UPGRADE_REGIONS: readonly Region[] = [
  [8, 83, 380, 428],
  [388, 83, 379, 428],
  [771, 83, 378, 428],
  [1152, 83, 380, 428],
  [8, 527, 380, 432],
  [388, 527, 379, 432],
  [771, 527, 378, 432],
  [1152, 527, 380, 432],
];
const GAME_CARDS = { plinko: 0, crash: 1, crossing: 2, mines: 3 } as const;
const SUPER_TIERS = { 5: 'MINI', 10: 'MINOR', 25: 'MAJOR', 100: 'GRAND' } as const;

export function wheelCardLabel(segment: WheelSegment, upgraded = false): string {
  if (segment.kind === 'chips') {
    const tier = upgraded ? SUPER_TIERS[segment.multiplier as keyof typeof SUPER_TIERS] : null;
    const amount = segment.amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return `${tier ? `${tier} ` : ''}${amount} Chips`;
  }
  if (segment.kind === 'bonus') {
    const name = {
      plinko: 'Plinko',
      crash: 'Crash',
      crossing: 'Donkey Cross',
      mines: 'Diamond Mines',
    }[segment.game ?? 'plinko'];
    return `${upgraded ? 'Super ' : ''}${name}`;
  }
  if (segment.kind === 'upgrade') return 'UPGRADE';
  return {
    throwables: 'Throwables',
    time_bank: 'Time Bank',
    rabbit_hunt: 'Rabbit Hunt',
    diamonds: 'Diamonds',
    nothing: segment.label,
  }[segment.kind];
}

function cardIndex(segment: WheelSegment, upgraded: boolean): number {
  if (segment.kind === 'bonus') return GAME_CARDS[segment.game ?? 'plinko'];
  if (upgraded) return 4 + Math.max(0, [5, 10, 25, 100].indexOf(segment.multiplier ?? 5));
  if (segment.kind === 'upgrade') return 4;
  if (segment.kind === 'chips')
    return 4 + Math.min(3, Math.max(1, Math.trunc(segment.multiplier ?? 1)));
  return { throwables: 8, time_bank: 9, rabbit_hunt: 10, diamonds: 11, nothing: 11 }[segment.kind];
}

function at(radius: number, degrees: number) {
  return point(radius, degrees).join(',');
}
type Point = readonly [number, number];
function point(radius: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  return [500 + Math.sin(radians) * radius, 500 - Math.cos(radians) * radius];
}

function arcSector(outer: number, inner: number, half: number) {
  return `M${at(outer, -half)} A${outer},${outer} 0 0 1 ${at(outer, half)} L${at(inner, half)} A${inner},${inner} 0 0 0 ${at(inner, -half)}Z`;
}

function triangle(source: readonly Point[], destination: readonly Point[]) {
  const [s0, s1, s2] = source,
    [p0, p1, p2] = destination;
  const u1 = s1[0] - s0[0],
    v1 = s1[1] - s0[1],
    u2 = s2[0] - s0[0],
    v2 = s2[1] - s0[1];
  const x1 = p1[0] - p0[0],
    y1 = p1[1] - p0[1],
    x2 = p2[0] - p0[0],
    y2 = p2[1] - p0[1];
  const determinant = u1 * v2 - u2 * v1;
  const a = (x1 * v2 - x2 * v1) / determinant,
    b = (y1 * v2 - y2 * v1) / determinant;
  const c = (u1 * x2 - u2 * x1) / determinant,
    d = (u1 * y2 - u2 * y1) / determinant;
  const center: Point = [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3];
  // Subpixel overlap prevents hairline cracks between antialiased triangles.
  const clip = destination
    .map(([x, y]) => {
      const distance = Math.hypot(x - center[0], y - center[1]);
      return `${x + ((x - center[0]) * 0.3) / distance},${y + ((y - center[1]) * 0.3) / distance}`;
    })
    .join(' ');
  return {
    clip,
    transform: `matrix(${a} ${b} ${c} ${d} ${p0[0] - a * s0[0] - c * s0[1]} ${p0[1] - b * s0[0] - d * s0[1]})`,
  };
}

/** A small affine texture mesh seats the original painted pixels on a true
 * annular sector. Static geometry is memoized; only the parent's rotor moves. */
function PaintedBand({
  region,
  atlas,
  atlasWidth,
  atlasHeight,
  outer,
  inner,
  start,
  end,
  slices = 18,
}: {
  region: Region;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  outer: number;
  inner: number;
  start: number;
  end: number;
  slices?: number;
}) {
  const id = `card-mesh-${useId().replace(/:/g, '')}`;
  const [sx, sy, sw, sh] = region;
  const mesh = useMemo(
    () =>
      Array.from({ length: slices }, (_, index) => {
        const left = start + ((end - start) * index) / slices,
          right = start + ((end - start) * (index + 1)) / slices;
        const x0 = sx + (sw * index) / slices,
          x1 = sx + (sw * (index + 1)) / slices;
        const a = point(outer, left),
          b = point(outer, right),
          c = point(inner, right),
          d = point(inner, left);
        return [
          triangle(
            [
              [x0, sy],
              [x1, sy],
              [x1, sy + sh],
            ],
            [a, b, c]
          ),
          triangle(
            [
              [x0, sy],
              [x1, sy + sh],
              [x0, sy + sh],
            ],
            [a, c, d]
          ),
        ];
      }).flat(),
    [sx, sy, sw, sh, slices, start, end, outer, inner]
  );
  return (
    <g aria-hidden="true">
      <defs>
        {mesh.map((t, index) => (
          <clipPath key={index} id={`${id}-${index}`}>
            <polygon points={t.clip} />
          </clipPath>
        ))}
      </defs>
      {mesh.map((t, index) => (
        <g key={index} clipPath={`url(#${id}-${index})`}>
          <image href={atlas} width={atlasWidth} height={atlasHeight} transform={t.transform} />
        </g>
      ))}
    </g>
  );
}

export interface WheelPrizeCardProps {
  segment: WheelSegment;
  startAngle: number;
  endAngle: number;
  outerRadius: number;
  innerRadius: number;
  upgraded?: boolean;
  /** Preview can use the approved source sheet without copying its pixels. */
  atlasUrl?: string;
}

/** Artwork only. The parent rotor owns selection, timing, motion and receipts. */
export function WheelPrizeCard({
  segment,
  startAngle,
  endAngle,
  outerRadius,
  innerRadius,
  upgraded = false,
  atlasUrl,
}: WheelPrizeCardProps) {
  const id = `prize-card-${useId().replace(/:/g, '')}`;
  const region = (upgraded ? UPGRADE_REGIONS : MAIN_REGIONS)[cardIndex(segment, upgraded)];
  const atlas =
    atlasUrl ??
    `${import.meta.env.BASE_URL}assets/diamond-spins/${upgraded ? 'wheel-upgrade-cards-v1.png' : 'wheel-main-cards-v1.png'}`;
  const half = (endAngle - startAngle) / 2 - 1.1;
  const mid = (startAngle + endAngle) / 2;
  const outer = outerRadius - 6;
  const inner = innerRadius + 6;
  const source = {
    atlas,
    atlasWidth: upgraded ? 1536 : 1448,
    atlasHeight: upgraded ? 1024 : 1086,
    start: -half,
    end: half,
  };
  const label = wheelCardLabel(segment, upgraded);
  const labelRadius = upgraded ? inner + 23 : outer - 35;
  const amountStart = upgraded ? 1 : -half + 2,
    amountEnd = half - 2;
  const [x, y, width, height] = region;
  return (
    <g
      className={styles.card}
      transform={`rotate(${mid} 500 500)`}
      data-wheel-card={segment.kind}
      data-card-index={cardIndex(segment, upgraded)}
      data-upgraded={upgraded || undefined}
      role="img"
      aria-label={label}
    >
      <defs>
        <clipPath id={id}>
          <path d={arcSector(outer, inner, half)} />
        </clipPath>
        <clipPath id={`${id}-rim`}>
          <path
            d={`${arcSector(outer, inner, half)} ${arcSector(outer - 5, inner + 5, half - 0.8)}`}
            clipRule="evenodd"
          />
        </clipPath>
        <path
          id={`${id}-amount`}
          d={`M${at(labelRadius, amountStart)} A${labelRadius},${labelRadius} 0 0 1 ${at(labelRadius, amountEnd)}`}
        />
      </defs>
      <g clipPath={`url(#${id})`}>
        {upgraded ? (
          <>
            <PaintedBand
              {...source}
              region={[x + 35, y + 145, width - 70, height - 205]}
              outer={outer - 5}
              inner={inner + 5}
              end={-2}
            />
            <PaintedBand
              {...source}
              region={[x + 40, y + 38, width - 80, segment.kind === 'chips' ? 85 : 115]}
              outer={outer - 5}
              inner={segment.kind === 'chips' ? inner + 45 : inner + 8}
              start={-2}
            />
            {segment.kind === 'chips' && (
              <PaintedBand
                {...source}
                region={[x + 45, y + height - 87, width - 90, 48]}
                outer={inner + 44}
                inner={inner + 7}
                start={-2}
              />
            )}
          </>
        ) : (
          <>
            <PaintedBand
              {...source}
              region={[x + 28, y + 263, width - 56, 52]}
              outer={outer - 4}
              inner={outer - 55}
            />
            <PaintedBand
              {...source}
              region={[x + 28, y + 28, width - 56, 235]}
              outer={outer - 55}
              inner={inner + 61}
            />
            <PaintedBand
              {...source}
              // The approved blank well continues the quilted blue chassis
              // through the narrow tip without stretching the prize scene.
              region={[430, 665, 207, 29]}
              outer={inner + 61}
              inner={inner + 4}
            />
          </>
        )}
        <g clipPath={`url(#${id}-rim)`}>
          <PaintedBand {...source} region={region} outer={outer} inner={inner} />
        </g>
        {segment.kind === 'chips' && (
          <text
            className={styles.amount}
            fontSize={upgraded ? 18 : 20}
            textAnchor="middle"
            textLength={((labelRadius * (amountEnd - amountStart) * Math.PI) / 180) * 0.88}
            lengthAdjust="spacingAndGlyphs"
          >
            <textPath href={`#${id}-amount`} startOffset="50%">
              {segment.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} CHIPS
            </textPath>
          </text>
        )}
      </g>
    </g>
  );
}
