import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { WheelSegment } from '../../services/DiamondWheelService';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { soundService } from '../../services/SoundService';
import {
  wheelLandingRotation,
  wheelPegTimes,
  wheelTravel,
  wheelPointerDeflection,
  WHEEL_SPIN_MS,
} from '../../utils/diamondWheelMotion';
import { WheelPrizeArt } from './WheelPrizeArt';
import { WheelPrizeCard } from './WheelPrizeCard';
import styles from './DiamondWheel.module.css';

export interface DiamondWheelProps {
  segments: WheelSegment[];
  landingOrd: number | null;
  spinKey: number;
  spinning: boolean;
  onLanded: () => void;
  size?: number;
  fitViewport?: boolean;
  upgraded?: boolean;
  idleDirection?: 1 | -1;
  showSelector?: boolean;
  faceScale?: number;
  upgradeExpanded?: boolean;
  presentation?: 'cabinet' | 'complete' | 'assembly';
}

/** The published order is part of the versioned server table, never an outcome calculation. */
export function arrangeForDisplay(segments: WheelSegment[]): WheelSegment[] {
  return [...segments].sort((a, b) => a.ord - b.ord);
}

function materialClass(seg: WheelSegment): string {
  if (seg.kind === 'upgrade') return styles.upgrade;
  if (seg.kind === 'bonus') return styles.bonus;
  if (seg.kind === 'chips') return styles.chips;
  return styles.reward;
}

export function wheelLabel(segment: WheelSegment, upgraded = false): string {
  if (segment.kind === 'bonus') {
    const name = { plinko: 'Plinko', crash: 'Crash', crossing: 'Donkey Cross', mines: 'Mines' }[
      segment.game ?? 'plinko'
    ];
    return upgraded ? `Super ${name}` : name;
  }
  if (segment.kind === 'upgrade') return 'UPGRADE';
  if (segment.kind === 'chips') {
    const amount = segment.amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const tier = upgraded
      ? ({ 5: 'MINI', 10: 'MINOR', 25: 'MAJOR', 100: 'GRAND' }[segment.multiplier ?? 0] ?? '')
      : '';
    return `${tier ? `${tier} ` : ''}${amount} Chips`;
  }
  if (segment.kind === 'time_bank') return 'Time Bank';
  if (segment.kind === 'rabbit_hunt') return 'Rabbit Hunt';
  if (segment.kind === 'throwables') return 'Throwables';
  if (segment.kind === 'diamonds') return 'Diamonds';
  return segment.label;
}

function point(radius: number, angle: number): [number, number] {
  const a = ((angle - 90) * Math.PI) / 180;
  return [500 + Math.cos(a) * radius, 500 + Math.sin(a) * radius];
}

function sector(outer: number, inner: number, start: number, end: number): string {
  const a = point(outer, start);
  const b = point(outer, end);
  const c = point(inner, end);
  const d = point(inner, start);
  const large = end - start > 180 ? 1 : 0;
  return `M${a} A${outer},${outer} 0 ${large} 1 ${b} L${c} A${inner},${inner} 0 ${large} 0 ${d}Z`;
}

/** A server-selected outcome with a single physical clock for motion and sound. */
export default function DiamondWheel({
  segments,
  landingOrd,
  spinKey,
  spinning,
  onLanded,
  size = 760,
  fitViewport = false,
  upgraded = false,
  idleDirection = 1,
  presentation = 'cabinet',
  showSelector = true,
  faceScale = 1,
  upgradeExpanded = false,
}: DiamondWheelProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [apertureWidth, setApertureWidth] = useState(360);
  useEffect(() => {
    if (!fitViewport || !frame.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (height > 0) setApertureWidth(Math.max(360, (415 * width) / height));
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [fitViewport]);
  const arranged = useMemo(() => arrangeForDisplay(segments), [segments]);
  const id = `wheel-${useId().replace(/:/g, '')}`;
  const rotor = useRef<SVGGElement>(null);
  const pointer = useRef<SVGGElement>(null);
  const position = useRef(0);
  const animation = useRef<{
    from: number;
    to: number;
    elapsed: number;
    duration: number;
    pegs: number[];
    nextPeg: number;
    sounded: boolean;
  } | null>(null);
  const startedKey = useRef<number | null>(null);
  const callback = useRef(onLanded);
  callback.current = onLanded;
  const props = useRef({ spinning, count: arranged.length, idleDirection });
  props.current = { spinning, count: arranged.length, idleDirection };
  const [settledOrd, setSettledOrd] = useState<number | null>(null);
  const settledRef = useRef<number | null>(null);
  const expectedOrd = useRef<number | null>(null);

  useEffect(() => {
    if (!spinning || landingOrd === null || startedKey.current === spinKey) return;
    const index = arranged.findIndex((segment) => segment.ord === landingOrd);
    if (index < 0) return;
    startedKey.current = spinKey;
    expectedOrd.current = landingOrd;
    settledRef.current = null;
    setSettledOrd(null);
    const from = position.current;
    const to = wheelLandingRotation(from, index, arranged.length);
    const duration = WHEEL_SPIN_MS * getAnimationSpeed();
    animation.current = {
      from,
      to,
      duration,
      elapsed: 0,
      pegs: wheelPegTimes(from, to, arranged.length, duration),
      nextPeg: 0,
      sounded: false,
    };
  }, [arranged, landingOrd, spinKey, spinning]);

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    const animate = (now: number) => {
      // Use visible elapsed time, not a frame-count surrogate. Clamping each
      // slow frame lengthens the selected spin on busy or software-rendered
      // devices. Visibility changes below reset the clock for background tabs.
      const elapsed = Math.max(0, now - previous);
      previous = now;
      if (document.hidden) {
        frame = requestAnimationFrame(animate);
        return;
      }
      const run = animation.current;
      if (run && props.current.spinning) {
        if (!run.sounded) {
          run.sounded = true;
          soundService.playSpinStart();
          // Close the launch bed; actual visible peg crossings own every click.
          soundService.playSpinTicking(0, []);
        }
        run.elapsed += elapsed;
        const progress = Math.min(1, run.elapsed / run.duration);
        while (run.nextPeg < run.pegs.length && run.pegs[run.nextPeg] <= run.elapsed) {
          soundService.playSpinPeg(0.5 + (0.5 * run.nextPeg) / Math.max(1, run.pegs.length - 1));
          run.nextPeg += 1;
        }
        position.current = run.from + (run.to - run.from) * wheelTravel(progress);
        if (progress === 1) {
          animation.current = null;
          settledRef.current = expectedOrd.current;
          setSettledOrd(expectedOrd.current);
          soundService.playSpinResult();
          callback.current();
        }
      } else if (!props.current.spinning) {
        animation.current = null;
        if (settledRef.current === null)
          position.current += (elapsed / 1000) * 3 * props.current.idleDirection;
      }
      const moving =
        Boolean(animation.current && props.current.spinning) ||
        (!props.current.spinning && settledRef.current === null);
      const direction = props.current.spinning ? 1 : props.current.idleDirection;
      pointer.current?.setAttribute(
        'transform',
        `rotate(${
          moving ? wheelPointerDeflection(position.current, props.current.count, direction) : 0
        } 500 156)`
      );
      rotor.current?.setAttribute('transform', `rotate(${position.current} 500 500)`);
      frame = requestAnimationFrame(animate);
    };
    const visibility = () => {
      previous = performance.now();
    };
    document.addEventListener('visibilitychange', visibility);
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  const assembled = presentation === 'assembly';
  const outerRing = assembled && upgraded;
  const outerRadius = outerRing ? 468 : 344;
  const innerRadius = outerRing ? (upgradeExpanded ? 204 : 334) : 88;
  const count = Math.max(1, arranged.length);
  const step = 360 / count;
  const material = (seg: WheelSegment) =>
    seg.kind === 'upgrade'
      ? 'upgrade'
      : seg.kind === 'bonus'
        ? 'bonus'
        : seg.kind === 'chips'
          ? 'chips'
          : 'glass';
  return (
    <div
      ref={frame}
      className={styles.frame}
      style={{ width: size, maxWidth: '100%' }}
      data-fit-viewport={fitViewport || undefined}
      data-motion="keep"
      data-phase={spinning ? 'spinning' : settledOrd === null ? 'idle' : 'landed'}
      data-upgraded={upgraded || undefined}
      data-idle-direction={idleDirection}
      data-presentation={presentation}
      data-prize-scale={(presentation === 'cabinet' || assembled) && !upgraded ? 2 : 1}
    >
      <div className={styles.aura} aria-hidden="true" />
      <svg
        viewBox={
          assembled
            ? fitViewport
              ? `${500 - apertureWidth / 2} 0 ${apertureWidth} 415`
              : '320 0 360 415'
            : presentation === 'cabinet'
              ? upgraded
                ? '140 45 720 485'
                : '320 70 360 345'
              : '0 0 1000 1000'
        }
        className={styles.svg}
        role="img"
        aria-label={upgraded ? 'Upgrade Wheel' : 'Diamond Wheel'}
      >
        <defs>
          <clipPath id={`${id}-outer-housing`}>
            <path
              d="M0 0H1000V1000H0Z M968 500A468 468 0 1 0 32 500A468 468 0 1 0 968 500Z"
              clipRule="evenodd"
            />
          </clipPath>
          <clipPath id={`${id}-bearing`}>
            <path
              d="M863 500A363 363 0 1 0 137 500A363 363 0 1 0 863 500Z M841 500A341 341 0 1 0 159 500A341 341 0 1 0 841 500Z"
              clipRule="evenodd"
            />
          </clipPath>
          <linearGradient id={`${id}-chrome`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#9aa5b3" />
            <stop offset=".4" stopColor="#9aa5b3" stopOpacity=".6" />
            <stop offset="1" stopColor="#050607" />
          </linearGradient>
          {(['glass', 'bonus', 'chips', 'upgrade'] as const).map((name) => (
            <radialGradient key={name} id={`${id}-${name}`} cx=".25" cy=".1" r=".9">
              <stop
                stopColor={
                  name === 'upgrade' ? '#ffd700' : name === 'bonus' ? '#45adff' : '#9aa5b3'
                }
                stopOpacity={name === 'bonus' || name === 'upgrade' ? 0.75 : 0.35}
              />
              <stop
                offset=".3"
                stopColor={name === 'bonus' || name === 'upgrade' ? '#1877f2' : '#050607'}
              />
              <stop offset="1" stopColor="#000" />
            </radialGradient>
          ))}
          <radialGradient id={`${id}-light`}>
            <stop stopColor="#f4f7fb" />
            <stop offset=".22" stopColor="#45adff" />
            <stop offset="1" stopColor="#1877f2" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#000" stopOpacity=".3" />
            <stop offset=".2" stopColor="#000" stopOpacity="0" />
            <stop offset=".8" stopColor="#000" stopOpacity=".1" />
            <stop offset="1" stopColor="#000" stopOpacity=".35" />
          </linearGradient>
          <linearGradient id={`${id}-cut-edge`} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#9aa5b3" />
            <stop offset=".12" stopColor="#9aa5b3" stopOpacity=".6" />
            <stop offset=".32" stopColor="#050607" />
            <stop offset=".78" stopColor="#050607" />
            <stop offset="1" stopColor="#9aa5b3" />
          </linearGradient>
          <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="170%">
            <feDropShadow dx="0" dy="8" stdDeviation="7" floodOpacity=".9" />
          </filter>
        </defs>
        <g className={styles.face} style={{ transform: `scale(${faceScale})` }} data-wheel-face>
          {outerRing ? (
            <circle cx="500" cy="500" r="474" fill="#050607" />
          ) : (
            <circle cx="500" cy="500" r="352" fill="#050607" />
          )}
          <g ref={rotor} data-wheel-rotor data-motion="keep">
            {arranged.map((segment, index) => {
              const start = index * step;
              const end = start + step;
              const winner = settledOrd === segment.ord;
              return (
                <g
                  key={segment.ord}
                  className={`${materialClass(segment)} ${segment.locked ? styles.locked : ''}`}
                  data-slot={segment.ord}
                  data-winner={winner || undefined}
                >
                  <path
                    d={sector(outerRadius, innerRadius, start + 0.6, end - 0.6)}
                    fill="#000"
                    transform="translate(0 8)"
                  />
                  <path
                    d={sector(outerRadius, innerRadius, start + 0.6, end - 0.6)}
                    fill={`url(#${id}-chrome)`}
                    stroke="#050607"
                    strokeWidth="1.5"
                  />
                  <path
                    d={sector(outerRadius - 2, innerRadius + 2, start + 0.9, end - 0.9)}
                    fill={`url(#${id}-cut-edge)`}
                    stroke="#e4e7ec"
                    strokeOpacity=".45"
                    strokeWidth=".7"
                  />
                  <path
                    d={sector(outerRadius - 6, innerRadius + 7, start + 1.35, end - 1.35)}
                    fill="#050607"
                    stroke="#000"
                    strokeWidth="2.5"
                  />
                  <path
                    d={sector(outerRadius - 10, innerRadius + 11, start + 1.7, end - 1.7)}
                    fill={`url(#${id}-${material(segment)})`}
                    stroke={`url(#${id}-cut-edge)`}
                    strokeWidth="2"
                  />
                  <path
                    d={sector(outerRadius - 14, innerRadius + 15, start + 2.2, end - 2.2)}
                    fill={`url(#${id}-sheen)`}
                  />
                  <path
                    d={sector(outerRadius - 16, innerRadius + 17, start + 2.3, end - 2.3)}
                    className={styles.sectorLight}
                    fill="none"
                    stroke={winner ? '#f4f7fb' : '#45adff'}
                    strokeWidth={winner ? 4 : 1}
                  />
                  <WheelPrizeCard
                    segment={segment}
                    startAngle={start}
                    endAngle={end}
                    outerRadius={outerRadius}
                    innerRadius={innerRadius}
                    upgraded={upgraded}
                    titleOnly={outerRing && !upgradeExpanded}
                  />
                </g>
              );
            })}
          </g>
          {(!assembled || upgraded) && (
            <image
              clipPath={outerRing ? `url(#${id}-outer-housing)` : undefined}
              href={`${import.meta.env.BASE_URL}assets/diamond-spins/${outerRing ? 'wheel-matte-rim-v1.png' : 'wheel-chrome-housing-v1.png'}`}
              x={outerRing ? -18 : 0}
              y={outerRing ? -18 : 0}
              width={outerRing ? 1036 : 1000}
              height={outerRing ? 1036 : 1000}
              pointerEvents="none"
            />
          )}
          {assembled && !upgraded && (
            <image
              href={`${import.meta.env.BASE_URL}assets/diamond-spins/wheel-matte-rim-v1.png`}
              x="64"
              y="64"
              width="872"
              height="872"
              clipPath={`url(#${id}-bearing)`}
              pointerEvents="none"
            />
          )}
          {(!assembled || upgraded) &&
            Array.from({ length: 48 }, (_, i) => {
              const [x, y] = point(outerRing ? 482 : 424, i * 7.5);
              return (
                <circle
                  key={i}
                  cx={x}
                  cy={y}
                  r="5"
                  fill={`url(#${id}-light)`}
                  className={styles.lamp}
                  style={{ animationDelay: `${i * -0.045}s` }}
                />
              );
            })}
          {!outerRing && (
            <g filter={`url(#${id}-shadow)`}>
              <circle cx="500" cy="500" r="102" fill={`url(#${id}-chrome)`} />
              <circle cx="500" cy="500" r="91" fill="#050607" stroke="#45adff" strokeWidth="2" />
              <circle cx="500" cy="500" r="85" fill={`url(#${id}-glass)`} />
              <svg x="437" y="433" width="126" height="118" className={styles.hubStone}>
                <WheelPrizeArt segment={{ kind: upgraded ? 'upgrade' : 'diamonds' }} />
              </svg>
              <text x="500" y="568" className={styles.hubLabel} textAnchor="middle">
                {upgraded ? 'UPGRADE' : 'Diamond Spins'}
              </text>
            </g>
          )}
          {showSelector && (
            <g data-wheel-selector transform={outerRing ? 'translate(0 -124)' : undefined}>
              <image
                href={`${import.meta.env.BASE_URL}assets/diamond-spins/wheel-selector-mount-v1.png`}
                x="390"
                y="128"
                width="220"
                height="80"
                aria-hidden="true"
              />
              <g ref={pointer} filter={`url(#${id}-shadow)`}>
                <image
                  href={`${import.meta.env.BASE_URL}assets/diamond-spins/wheel-selector-matte-v1.png`}
                  x="487"
                  y="152"
                  width="26"
                  height="39"
                  className={styles.selectorCrystal}
                  aria-hidden="true"
                />
              </g>
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}
