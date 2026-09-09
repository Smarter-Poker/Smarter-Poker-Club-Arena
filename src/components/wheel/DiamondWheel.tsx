/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WHEEL - the wheel itself
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A machined casino wheel drawn in SVG: a brushed-gold rim set with lamps, an
 * inner bevel, eleven equal segments cut from three materials (gold for chips,
 * arena cyan for diamonds, gunmetal for nothing), a jewelled hub and a gold
 * pointer at twelve o'clock. Depth comes from gradients and layered shadows, not
 * from a flat fill, per Dan's standing rule that nothing on smarter.poker looks
 * flat.
 *
 * THE WHEEL DOES NOT CHOOSE. It receives the winning segment from the server
 * (fn_wheel_spin) and rotates so that segment stops under the pointer. Equal
 * arcs, unequal odds: the odds table beside the wheel states every probability,
 * and a locked segment (one the host cannot pay right now) is drawn dimmed with
 * a lock glyph rather than hidden, so the player sees what is off the table.
 *
 * The spin is a CSS transition on the wheel group's rotation. It is a
 * duration-carrying animation (the landing IS the result), so the element
 * carries data-motion="keep" and its duration scales with the player's
 * --animation-speed like every other animation in the app (CLAUDE.md 10.6).
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { WheelSegment } from '../../services/DiamondWheelService';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { soundService } from '../../services/SoundService';
import styles from './DiamondWheel.module.css';

export interface DiamondWheelProps {
  segments: WheelSegment[];
  /** The ord the server said won. null while idle. */
  landingOrd: number | null;
  /** Increments each spin so the same ord twice in a row still spins. */
  spinKey: number;
  spinning: boolean;
  onLanded: () => void;
  size?: number;
}

const BASE_SPIN_SECONDS = 5.2;
const TURNS = 5;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number
): string {
  const [x0, y0] = polar(cx, cy, rOuter, a0);
  const [x1, y1] = polar(cx, cy, rOuter, a1);
  const [x2, y2] = polar(cx, cy, rInner, a1);
  const [x3, y3] = polar(cx, cy, rInner, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return [
    `M ${x0.toFixed(3)} ${y0.toFixed(3)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`,
    `L ${x2.toFixed(3)} ${y2.toFixed(3)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x3.toFixed(3)} ${y3.toFixed(3)}`,
    'Z',
  ].join(' ');
}

/** Interleave the table so gold and cyan alternate around the rim. */
export function arrangeForDisplay(segments: WheelSegment[]): WheelSegment[] {
  const byValue = [...segments].sort((a, b) => a.value_chips - b.value_chips);
  const out: WheelSegment[] = [];
  let lo = 0;
  let hi = byValue.length - 1;
  let takeLow = true;
  while (lo <= hi) {
    out.push(takeLow ? byValue[lo++] : byValue[hi--]);
    takeLow = !takeLow;
  }
  return out;
}

function materialClass(seg: WheelSegment): string {
  if (seg.kind === 'chips') return seg.value_chips >= 20 ? styles.segGoldHot : styles.segGold;
  if (seg.kind === 'diamonds') return styles.segCyan;
  return styles.segDark;
}

function amountLabel(seg: WheelSegment): string {
  if (seg.kind === 'nothing') return 'Nothing';
  if (seg.kind === 'diamonds') return `${seg.amount.toLocaleString()} ◆`;
  const chips = seg.amount;
  return chips >= 1
    ? `${chips.toLocaleString()} ${chips === 1 ? 'Chip' : 'Chips'}`
    : `${chips.toFixed(2)} Chips`;
}

export default function DiamondWheel({
  segments,
  landingOrd,
  spinKey,
  spinning,
  onLanded,
  size = 340,
}: DiamondWheelProps) {
  const arranged = useMemo(() => arrangeForDisplay(segments), [segments]);
  const n = Math.max(arranged.length, 1);
  const step = 360 / n;
  const [rotation, setRotation] = useState(0);
  const [durationSec, setDurationSec] = useState(BASE_SPIN_SECONDS);
  const rotationRef = useRef(0);
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const landedRef = useRef(false);

  useEffect(() => {
    if (!spinning || landingOrd === null) return;
    const idx = arranged.findIndex((s) => s.ord === landingOrd);
    if (idx < 0) return;
    const speed = getAnimationSpeed();
    const dur = BASE_SPIN_SECONDS * speed;
    setDurationSec(dur);
    // The pointer is at 0 degrees (twelve o'clock). Segment idx spans
    // [idx*step, (idx+1)*step) when unrotated; bring its centre under the
    // pointer, after TURNS full revolutions past the current heading.
    const centre = idx * step + step / 2;
    const current = rotationRef.current;
    const base = Math.ceil(current / 360) * 360;
    const jitter = (Math.random() - 0.5) * step * 0.6; // never on a seam
    const target = base + TURNS * 360 + (360 - centre) + jitter;
    rotationRef.current = target;
    landedRef.current = false;
    setRotation(target);
    /* THE SOUND IS THE SAME KIT THE SPIN LADDER USES (components/tournament/
       SpinWheel): a start, a tick that decelerates over exactly the duration
       this wheel is turning for, and the result on the stop. Nothing new was
       designed and nothing is loaded: SoundService synthesises it, respects
       the player's own sound settings, and refuses politely when the tab has
       no audio. */
    soundService.playSpinStart();
    soundService.playSpinTicking(dur * 1000);
    fallbackRef.current = setTimeout(
      () => {
        if (!landedRef.current) {
          landedRef.current = true;
          soundService.playSpinResult();
          onLanded();
        }
      },
      dur * 1000 + 250
    );
    return () => {
      if (fallbackRef.current) clearTimeout(fallbackRef.current);
    };
    // spinKey makes a repeated ord spin again; arranged/step are stable per table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinKey, spinning, landingOrd]);

  const handleTransitionEnd = () => {
    if (!spinning || landedRef.current) return;
    landedRef.current = true;
    if (fallbackRef.current) clearTimeout(fallbackRef.current);
    soundService.playSpinResult();
    onLanded();
  };

  const cx = 200;
  const cy = 200;
  const rRim = 196;
  const rOuter = 172;
  const rInner = 54;
  const rLabel = 122;

  const wheelStyle: CSSProperties = {
    transform: `rotate(${rotation}deg)`,
    transition: spinning ? `transform ${durationSec}s cubic-bezier(0.12, 0.72, 0.08, 1)` : 'none',
    transformOrigin: '200px 200px',
    willChange: 'transform',
  };

  return (
    <div className={styles.frame} style={{ width: size, height: size }} data-motion="keep">
      <svg
        viewBox="0 0 400 400"
        width={size}
        height={size}
        className={styles.svg}
        role="img"
        aria-label="Diamond Wheel"
      >
        <defs>
          <linearGradient id="dw-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f6e2a0" />
            <stop offset="0.28" stopColor="#c99a2e" />
            <stop offset="0.52" stopColor="#f3d27a" />
            <stop offset="0.76" stopColor="#9c6f16" />
            <stop offset="1" stopColor="#e8c463" />
          </linearGradient>
          <radialGradient id="dw-face" cx="0.5" cy="0.45" r="0.6">
            <stop offset="0" stopColor="rgba(255,255,255,0.10)" />
            <stop offset="0.7" stopColor="rgba(255,255,255,0)" />
            <stop offset="1" stopColor="rgba(0,0,0,0.35)" />
          </radialGradient>
          <linearGradient id="dw-gold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffd97a" />
            <stop offset="0.55" stopColor="#d9a32c" />
            <stop offset="1" stopColor="#8a5f10" />
          </linearGradient>
          <linearGradient id="dw-gold-hot" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff2b8" />
            <stop offset="0.5" stopColor="#ffc93c" />
            <stop offset="1" stopColor="#b57a12" />
          </linearGradient>
          <linearGradient id="dw-cyan" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8fe9ff" />
            <stop offset="0.55" stopColor="#00b8e0" />
            <stop offset="1" stopColor="#065f7a" />
          </linearGradient>
          <linearGradient id="dw-dark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3a4756" />
            <stop offset="0.6" stopColor="#1a222c" />
            <stop offset="1" stopColor="#0b1017" />
          </linearGradient>
          <radialGradient id="dw-hub" cx="0.5" cy="0.4" r="0.7">
            <stop offset="0" stopColor="#5b6a7c" />
            <stop offset="0.55" stopColor="#1c2531" />
            <stop offset="1" stopColor="#070a0f" />
          </radialGradient>
          <linearGradient id="dw-pointer" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff0b0" />
            <stop offset="0.5" stopColor="#f0c040" />
            <stop offset="1" stopColor="#9a6a12" />
          </linearGradient>
          <filter id="dw-drop" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="6" stdDeviation="6" floodColor="#000" floodOpacity="0.55" />
          </filter>
          <filter id="dw-inner" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        {/* The rim: brushed gold, a dark groove, and the lamps. */}
        <circle cx={cx} cy={cy} r={rRim} fill="url(#dw-rim)" filter="url(#dw-drop)" />
        <circle cx={cx} cy={cy} r={rRim - 10} fill="#0b1017" />
        <circle
          cx={cx}
          cy={cy}
          r={rRim - 12}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="1"
        />
        {Array.from({ length: 24 }).map((_, i) => {
          const [lx, ly] = polar(cx, cy, rRim - 5, i * 15);
          return (
            <circle
              key={i}
              cx={lx}
              cy={ly}
              r={2.6}
              className={spinning && i % 2 === 0 ? styles.lampOn : styles.lamp}
            />
          );
        })}

        {/* The face: segments rotate as one group. */}
        <g style={wheelStyle} onTransitionEnd={handleTransitionEnd}>
          {arranged.map((seg, i) => {
            const a0 = i * step;
            const a1 = (i + 1) * step;
            const mid = a0 + step / 2;
            const [tx, ty] = polar(cx, cy, rLabel, mid);
            return (
              <g key={seg.ord} className={seg.locked ? styles.segLocked : undefined}>
                <path
                  d={arcPath(cx, cy, rOuter, rInner, a0, a1)}
                  className={materialClass(seg)}
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="1.2"
                />
                <path
                  d={arcPath(cx, cy, rOuter, rInner, a0, a1)}
                  fill="url(#dw-face)"
                  pointerEvents="none"
                />
                <g transform={`translate(${tx.toFixed(2)} ${ty.toFixed(2)}) rotate(${mid})`}>
                  <text className={styles.segText} textAnchor="middle" y="-2">
                    {amountLabel(seg)}
                  </text>
                  {seg.locked ? (
                    <text className={styles.segLock} textAnchor="middle" y="14">
                      Locked
                    </text>
                  ) : null}
                </g>
              </g>
            );
          })}
          {/* Separator studs on the inner ring. */}
          {arranged.map((_, i) => {
            const [sx, sy] = polar(cx, cy, rInner + 4, i * step);
            return <circle key={`stud-${i}`} cx={sx} cy={sy} r={2} fill="#f3d27a" opacity="0.8" />;
          })}
        </g>

        {/* The hub. */}
        <circle cx={cx} cy={cy} r={rInner - 2} fill="url(#dw-rim)" />
        <circle
          cx={cx}
          cy={cy}
          r={rInner - 8}
          fill="url(#dw-hub)"
          stroke="rgba(255,255,255,0.12)"
        />
        <text x={cx} y={cy + 9} textAnchor="middle" className={styles.hubGlyph}>
          ◆
        </text>

        {/* The pointer at twelve o'clock. */}
        <g filter="url(#dw-drop)">
          <path
            d="M 200 18 L 216 46 L 200 60 L 184 46 Z"
            fill="url(#dw-pointer)"
            stroke="#5a3d08"
            strokeWidth="1.2"
          />
          <circle cx="200" cy="30" r="3" fill="#fff8d6" />
        </g>
      </svg>
    </div>
  );
}
