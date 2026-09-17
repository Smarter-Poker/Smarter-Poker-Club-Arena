import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { WheelSegment } from '../../services/DiamondWheelService';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { soundService } from '../../services/SoundService';
import {
  wheelLandingRotation,
  wheelPegTimes,
  wheelTravel,
  WHEEL_SPIN_MS,
} from '../../utils/diamondWheelMotion';
import { WheelPrizeArt } from './WheelPrizeArt';
import styles from './DiamondWheel.module.css';

export interface DiamondWheelProps {
  segments: WheelSegment[];
  landingOrd: number | null;
  spinKey: number;
  spinning: boolean;
  onLanded: () => void;
  size?: number;
  upgraded?: boolean;
  idleDirection?: 1 | -1;
  presentation?: 'cabinet' | 'complete';
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

function wheelLabel(segment: WheelSegment, upgraded = false): string {
  if (segment.kind === 'bonus') {
    const name = { plinko: 'Plinko', crash: 'Crash', crossing: 'Donkey Cross', mines: 'Mines' }[
      segment.game ?? 'plinko'
    ];
    return upgraded ? `Super ${name}` : name;
  }
  if (segment.kind === 'chips' && segment.multiplier) return `${segment.multiplier}x Chips`;
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
  upgraded = false,
  idleDirection = 1,
  presentation = 'cabinet',
}: DiamondWheelProps) {
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
      const elapsed = Math.min(50, now - previous);
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
        const sectorAngle = 360 / Math.max(1, props.current.count);
        const pegPhase = (position.current % sectorAngle) / sectorAngle;
        pointer.current?.setAttribute(
          'transform',
          `rotate(${pegPhase < 0.15 ? -16 * (1 - pegPhase / 0.15) : 0} 500 180)`
        );
        if (progress === 1) {
          animation.current = null;
          settledRef.current = expectedOrd.current;
          setSettledOrd(expectedOrd.current);
          pointer.current?.setAttribute('transform', 'rotate(0 500 180)');
          soundService.playSpinResult();
          callback.current();
        }
      } else if (!props.current.spinning) {
        animation.current = null;
        if (settledRef.current === null)
          position.current += (elapsed / 1000) * 3 * props.current.idleDirection;
      }
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
      className={styles.frame}
      style={{ width: size, maxWidth: '100%' }}
      data-motion="keep"
      data-phase={spinning ? 'spinning' : settledOrd === null ? 'idle' : 'landed'}
      data-upgraded={upgraded || undefined}
      data-idle-direction={idleDirection}
      data-presentation={presentation}
      data-prize-scale={presentation === 'cabinet' && !upgraded ? 2 : 1}
    >
      <div className={styles.aura} aria-hidden="true" />
      <svg
        viewBox={
          presentation === 'cabinet'
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
          <linearGradient id={`${id}-chrome`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#f4f7fb" />
            <stop offset=".17" stopColor="#9aa5b3" />
            <stop offset=".29" stopColor="#050607" />
            <stop offset=".43" stopColor="#e4e7ec" />
            <stop offset=".7" stopColor="#050607" />
            <stop offset="1" stopColor="#9aa5b3" />
          </linearGradient>
          {(['glass', 'bonus', 'chips', 'upgrade'] as const).map((name) => (
            <radialGradient key={name} id={`${id}-${name}`} cx=".25" cy=".1" r=".9">
              <stop
                stopColor={
                  name === 'upgrade' ? '#ffd700' : name === 'bonus' ? '#45adff' : '#9aa5b3'
                }
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
            <stop stopColor="#fff" stopOpacity=".3" />
            <stop offset=".35" stopColor="#fff" stopOpacity="0" />
            <stop offset=".65" stopColor="#000" stopOpacity=".5" />
            <stop offset="1" stopColor="#fff" stopOpacity=".15" />
          </linearGradient>
          <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="170%">
            <feDropShadow dx="0" dy="8" stdDeviation="7" floodOpacity=".9" />
          </filter>
        </defs>
        <circle cx="500" cy="500" r="352" fill="#050607" />
        <g ref={rotor} data-wheel-rotor data-motion="keep">
          {arranged.map((segment, index) => {
            const start = index * step;
            const end = start + step;
            const mid = start + step / 2;
            const [x, y] = point(250, mid);
            const winner = settledOrd === segment.ord;
            return (
              <g
                key={segment.ord}
                className={`${materialClass(segment)} ${segment.locked ? styles.locked : ''}`}
                data-slot={segment.ord}
                data-winner={winner || undefined}
              >
                <path
                  d={sector(344, 88, start + 0.6, end - 0.6)}
                  fill="#000"
                  transform="translate(0 9)"
                />
                <path d={sector(344, 88, start + 0.6, end - 0.6)} fill={`url(#${id}-chrome)`} />
                <path
                  d={sector(334, 99, start + 1.7, end - 1.7)}
                  fill={`url(#${id}-${material(segment)})`}
                />
                <path d={sector(330, 103, start + 2.2, end - 2.2)} fill={`url(#${id}-sheen)`} />
                <path
                  d={sector(328, 105, start + 2.3, end - 2.3)}
                  className={styles.sectorLight}
                  fill="none"
                  stroke={winner ? '#f4f7fb' : '#45adff'}
                  strokeWidth={winner ? 4 : 1}
                />
                <g transform={`translate(${x} ${y}) rotate(${mid})`}>
                  <g className={styles.prizeFloat} style={{ animationDelay: `${index * -0.24}s` }}>
                    <svg
                      x={count <= 8 ? -77 : -57}
                      y={count <= 8 ? -88 : -62}
                      width={count <= 8 ? 154 : 114}
                      height={count <= 8 ? 140 : 104}
                      overflow="visible"
                    >
                      <WheelPrizeArt segment={segment} />
                    </svg>
                  </g>
                  <text
                    className={styles.segText}
                    textAnchor="middle"
                    y={count <= 8 ? 77 : 65}
                    fontSize={count <= 8 ? 23 : 19}
                  >
                    {wheelLabel(segment, upgraded)
                      .split(' ')
                      .map((word, line) => (
                        <tspan key={line} x="0" dy={line ? '1.05em' : 0}>
                          {word}
                        </tspan>
                      ))}
                  </text>
                </g>
              </g>
            );
          })}
        </g>
        <image
          href={`${import.meta.env.BASE_URL}assets/diamond-spins/wheel-chrome-housing-v1.png`}
          width="1000"
          height="1000"
          pointerEvents="none"
        />
        {Array.from({ length: 48 }, (_, i) => {
          const [x, y] = point(424, i * 7.5);
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
        <g filter={`url(#${id}-shadow)`}>
          <circle cx="500" cy="500" r="102" fill={`url(#${id}-chrome)`} />
          <circle cx="500" cy="500" r="91" fill="#050607" stroke="#45adff" strokeWidth="2" />
          <circle cx="500" cy="500" r="85" fill={`url(#${id}-glass)`} />
          <svg x="437" y="433" width="126" height="118" className={styles.hubStone}>
            <WheelPrizeArt segment={{ kind: upgraded ? 'upgrade' : 'diamonds' }} />
          </svg>
          <text x="500" y="568" className={styles.hubLabel} textAnchor="middle">
            {upgraded ? 'Upgrade' : 'Diamond Spins'}
          </text>
        </g>
        <g ref={pointer} filter={`url(#${id}-shadow)`}>
          <path
            d="M475 166 L500 149 L525 166 L516 192 L500 225 L484 192Z"
            fill={`url(#${id}-chrome)`}
            stroke="#000"
            strokeWidth="2"
          />
          <path d="M490 171 L510 171 L507 191 L500 207 L493 191Z" fill="#45adff" />
          <circle cx="500" cy="174" r="9" fill={`url(#${id}-light)`} />
        </g>
      </svg>
    </div>
  );
}
