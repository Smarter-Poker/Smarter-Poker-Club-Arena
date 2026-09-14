/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WHEEL - the wheel itself
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A machined casino wheel drawn in SVG, cut from the console's own material
 * (#ClubArenaConsole, Dan 2026-09-09): a brushed-steel rim set with blue lamps,
 * an inner bevel, eleven equal segments in the master's inks (gold for the top
 * chip prizes, steel-blue glass for the rest of the chips, the club's blue for
 * diamonds, gunmetal for nothing), chrome spokes between them, the cut stone
 * from the Diamond Games mark set in a chrome hub, and a chrome pointer with a
 * lit blue tip at twelve o'clock. The gold-and-cyan wheel this replaces was
 * the one drawn thing on the page that did not belong to the chassis around
 * it. Depth comes from gradients and layered shadows, not from a flat fill.
 *
 * THE WHEEL DOES NOT CHOOSE. It receives the winning segment from the server
 * (fn_wheel_spin) and rotates so that segment stops under the pointer. Equal
 * arcs, unequal odds: the odds table beside the wheel states every probability,
 * and a locked segment (one the host cannot pay right now) is drawn dimmed with
 * a lock glyph rather than hidden, so the player sees what is off the table.
 *
 * THERE IS ONE TABLE (2026-09-11). This carried a `free` prop that re-inked
 * the rim by amount rather than by kind, because the retired daily free spin
 * drew a separate five-prize table that was all diamonds and would otherwise
 * have come out as one flat blue. The welcome spin that replaced it draws the
 * REAL wheel, so that rule was about to paint the real table by the wrong
 * scheme. The prop and the branch are gone: one table, one inking.
 *
 * The spin is a CSS transition on the wheel group's rotation. It is a
 * duration-carrying animation (the landing IS the result), so the element
 * carries data-motion="keep" and its duration scales with the player's
 * --animation-speed like every other animation in the app (CLAUDE.md 10.6).
 */

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DiamondMarkArt } from '../club-buttons/ClubButtons';
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

/** Gold is the top ink and stays rare: the two biggest chip prizes wear it. */
function materialClass(seg: WheelSegment): string {
  if (seg.kind === 'chips') return seg.value_chips >= 20 ? styles.segGoldHot : styles.segGlass;
  if (seg.kind === 'diamonds') return styles.segBlue;
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
  const hubId = useId().replace(/:/g, '');

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
          {/* The rim is the console's chrome: a bright turn at the top left,
              a dark turn at the bottom right, the way the master's rails go. */}
          <linearGradient id="dw-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f4f6f9" />
            <stop offset="0.24" stopColor="#a9b2bc" />
            <stop offset="0.5" stopColor="#e6eaef" />
            <stop offset="0.74" stopColor="#4a545f" />
            <stop offset="1" stopColor="#c9d0d8" />
          </linearGradient>
          <linearGradient id="dw-glass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3f6790" />
            <stop offset="0.55" stopColor="#1e3652" />
            <stop offset="1" stopColor="#0c1a2b" />
          </linearGradient>
          <radialGradient id="dw-face" cx="0.5" cy="0.45" r="0.6">
            <stop offset="0" stopColor="rgba(255,255,255,0.10)" />
            <stop offset="0.7" stopColor="rgba(255,255,255,0)" />
            <stop offset="1" stopColor="rgba(0,0,0,0.35)" />
          </radialGradient>
          <linearGradient id="dw-gold-hot" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff2b8" />
            <stop offset="0.5" stopColor="#ffc93c" />
            <stop offset="1" stopColor="#b57a12" />
          </linearGradient>
          <linearGradient id="dw-blue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8fd4ff" />
            <stop offset="0.55" stopColor="#3a9be6" />
            <stop offset="1" stopColor="#164f86" />
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
          <linearGradient id="dw-pointer" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f4f6f9" />
            <stop offset="0.45" stopColor="#9aa3ad" />
            <stop offset="1" stopColor="#3d4650" />
          </linearGradient>
          <radialGradient id="dw-led" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.35" stopColor="#8fd4ff" />
            <stop offset="1" stopColor="#45adff" stopOpacity="0" />
          </radialGradient>
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
                  stroke="rgba(226,232,238,0.42)"
                  strokeWidth="1.1"
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
            return <circle key={`stud-${i}`} cx={sx} cy={sy} r={2} fill="#d5dbe2" opacity="0.85" />;
          })}
        </g>

        {/* The hub: a chrome bezel, a dark well, and the same cut stone the
            Diamond Games mark carries, so the wheel and its door agree. */}
        <circle cx={cx} cy={cy} r={rInner - 2} fill="url(#dw-rim)" />
        <circle
          cx={cx}
          cy={cy}
          r={rInner - 8}
          fill="url(#dw-hub)"
          stroke="rgba(255,255,255,0.12)"
        />
        <svg x={cx - 24} y={cy - 24} width="48" height="48" viewBox="0 0 64 64" aria-hidden="true">
          <DiamondMarkArt uid={`dw-${hubId}`} />
        </svg>

        {/* The pointer at twelve o'clock. */}
        <g filter="url(#dw-drop)">
          <path
            d="M 200 18 L 216 46 L 200 60 L 184 46 Z"
            fill="url(#dw-pointer)"
            stroke="#1a2028"
            strokeWidth="1.2"
          />
          <circle cx="200" cy="32" r="7" fill="url(#dw-led)" />
          <circle cx="200" cy="32" r="2.6" fill="#dff2ff" />
        </g>
      </svg>
    </div>
  );
}
