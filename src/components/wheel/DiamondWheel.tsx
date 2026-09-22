import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { WheelSegment } from '../../services/DiamondWheelService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
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
  /**
   * Keep the landed prize under the pointer instead of drifting on. Defaults
   * to `landingOrd !== null`: while a receipt is being revealed the wheel
   * holds, and clearing it releases the wheel from its landed angle (owner
   * ruling 2026-09-21, R7).
   */
  holdResult?: boolean;
  /**
   * Stop the idle drift and its frame loop while something covers the wheel
   * (the win reveal). It never shortens an owed spin: a spin in progress
   * keeps its full duration, pegs and landing sound.
   */
  paused?: boolean;
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

/**
 * Selector geometry in wheel units (the 1000 x 1000 space). The holder is the
 * centre of the approved mount art cut around the hub axis
 * (scripts/art/derive-wheel-selector.py), so its axis sits on x=500 and the
 * hub on the rim at y=155. The pointer pivots about (500,156) exactly as the
 * v1 sprite did; its v2 file carries 8 units of baked shadow at each side, 4
 * above and 16 below the 26 x 39 sprite.
 */
const SELECTOR = {
  pivot: [500, 156] as const,
  holder: { x: 500 - (260 * 220) / 2081, y: 128 + (104 * 220) / 2081, w: (520 * 220) / 2081 },
  pointer: { x: 487 - 8, y: 152 - 4, w: 26 + 16, h: 39 + 20 },
} as const;
const ART = `${import.meta.env.BASE_URL}assets/diamond-spins/`;
const IDLE_DEGREES_PER_SECOND = 3;

/**
 * The idle drift runs on the compositor: one linear rotation of the rotor and
 * one repeating pointer deflection cycle (a sector's worth of the pawl
 * bending against each divider), both Web Animations with no frame callback
 * behind them. The main thread does nothing while the wheel idles.
 */
type IdleDrift = {
  rotor: Animation;
  pointer: Animation | null;
  from: number;
  direction: 1 | -1;
};
const POINTER_SAMPLES = 90;

function startIdleDrift(
  rotor: HTMLElement,
  pointer: HTMLElement | null,
  from: number,
  direction: 1 | -1,
  count: number
): IdleDrift | null {
  if (typeof rotor.animate !== 'function') return null;
  const turn = (360 / IDLE_DEGREES_PER_SECOND) * 1000;
  const rotorAnimation = rotor.animate(
    [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${from + direction * 360}deg)` }],
    { duration: turn, iterations: Infinity, easing: 'linear' }
  );
  let pointerAnimation: Animation | null = null;
  if (pointer && typeof pointer.animate === 'function') {
    const step = 360 / Math.max(1, count);
    const period = (step / IDLE_DEGREES_PER_SECOND) * 1000;
    const frames = Array.from({ length: POINTER_SAMPLES + 1 }, (_, k) => {
      const rotation = from + (direction * step * k) / POINTER_SAMPLES;
      return {
        offset: k / POINTER_SAMPLES,
        transform: `rotate(${wheelPointerDeflection(rotation, count, direction)}deg)`,
      };
    });
    pointerAnimation = pointer.animate(frames, {
      duration: period,
      iterations: Infinity,
      easing: 'linear',
    });
  }
  return { rotor: rotorAnimation, pointer: pointerAnimation, from, direction };
}

function idleDriftAngle(drift: IdleDrift): number {
  const time = drift.rotor.currentTime;
  const ms = typeof time === 'number' ? time : 0;
  return drift.from + (drift.direction * IDLE_DEGREES_PER_SECOND * ms) / 1000;
}

/** Where the wheel space lands on screen for a presentation's aperture. */
function aperture(
  presentation: 'cabinet' | 'complete' | 'assembly',
  upgraded: boolean,
  apertureWidth: number
): { x: number; y: number; w: number; h: number } {
  if (presentation === 'assembly')
    return { x: 500 - apertureWidth / 2, y: 0, w: apertureWidth, h: 415 };
  if (presentation === 'cabinet')
    return upgraded ? { x: 140, y: 45, w: 720, h: 485 } : { x: 320, y: 70, w: 360, h: 345 };
  return { x: 0, y: 0, w: 1000, h: 1000 };
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
  holdResult,
  paused = false,
}: DiamondWheelProps) {
  const frame = useRef<HTMLDivElement>(null);
  // The frame's box decides the aperture (fit-viewport widens it) and the
  // pixel size of one wheel unit; every layer is placed from these numbers.
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox((current) =>
        current.width === width && current.height === height ? current : { width, height }
      );
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const arranged = useMemo(() => arrangeForDisplay(segments), [segments]);
  const id = `wheel-${useId().replace(/:/g, '')}`;
  const rotor = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLDivElement>(null);
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
  const hold = holdResult ?? landingOrd !== null;
  const live = useRef({
    spinning,
    count: arranged.length,
    idleDirection,
    hold,
    paused,
    reducedMotion: false,
    onScreen: true,
  });
  live.current = { ...live.current, spinning, count: arranged.length, idleDirection, hold, paused };
  const [settledOrd, setSettledOrd] = useState<number | null>(null);
  const [settledAngle, setSettledAngle] = useState(0);
  const settledRef = useRef<number | null>(null);
  const expectedOrd = useRef<number | null>(null);
  const wake = useRef<() => void>(() => {});
  const drift = useRef<IdleDrift | null>(null);
  // The last transforms written inline, so an unchanged frame writes nothing.
  const written = useRef({ rotor: '', pointer: '' });
  const write = useCallback((rotation: number, deflection: number) => {
    const rotorTransform = `rotate(${rotation}deg)`;
    if (rotor.current && rotorTransform !== written.current.rotor) {
      rotor.current.style.transform = rotorTransform;
      written.current.rotor = rotorTransform;
    }
    const pointerTransform = `rotate(${deflection}deg)`;
    if (pointer.current && pointerTransform !== written.current.pointer) {
      pointer.current.style.transform = pointerTransform;
      written.current.pointer = pointerTransform;
    }
  }, []);
  /**
   * Take the drift's current angle into `position`, pin it inline, then stop
   * the animations: the frame that follows shows the same angle, never the
   * one the drift left from.
   */
  const settleDrift = useCallback(() => {
    const current = drift.current;
    if (!current) return;
    position.current = idleDriftAngle(current);
    write(
      position.current,
      wheelPointerDeflection(position.current, live.current.count, current.direction)
    );
    current.rotor.cancel();
    current.pointer?.cancel();
    drift.current = null;
  }, [write]);

  useEffect(() => {
    if (!spinning || landingOrd === null || startedKey.current === spinKey) return;
    const index = arranged.findIndex((segment) => segment.ord === landingOrd);
    if (index < 0) return;
    startedKey.current = spinKey;
    expectedOrd.current = landingOrd;
    settledRef.current = null;
    setSettledOrd(null);
    // The next spin leaves from wherever the idle drift has carried the wheel:
    // the same angle, expressed inside one turn so the landing arithmetic and
    // the peg schedule stay bounded however long the wheel has idled.
    settleDrift();
    const from = ((position.current % 360) + 360) % 360;
    position.current = from;
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
    wake.current();
  }, [arranged, landingOrd, spinKey, spinning, settleDrift]);

  useEffect(() => {
    let frameHandle: number | null = null;
    let previous = performance.now();
    const animate = (now: number) => {
      frameHandle = null;
      // Use visible elapsed time, not a frame-count surrogate. Clamping each
      // slow frame lengthens the selected spin on busy or software-rendered
      // devices. Visibility changes below reset the clock for background tabs.
      const elapsed = Math.max(0, now - previous);
      previous = now;
      if (document.hidden) {
        frameHandle = requestAnimationFrame(animate);
        return;
      }
      const state = live.current;
      const run = animation.current;
      let moving = false;
      if (run && state.spinning) {
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
        moving = true;
        if (progress === 1) {
          animation.current = null;
          moving = false;
          settledRef.current = expectedOrd.current;
          setSettledOrd(expectedOrd.current);
          setSettledAngle(position.current);
          soundService.playSpinResult();
          callback.current();
        }
      } else if (!state.spinning) {
        animation.current = null;
        // The reveal has been acknowledged: let go of the landed prize and
        // drift on from this very angle. Nothing snaps back to zero.
        if (settledRef.current !== null && !state.hold) {
          settledRef.current = null;
          setSettledOrd(null);
        }
        // Idle only while nothing covers the wheel, it is on screen and the
        // player has not asked for reduced motion (the owed spin above is
        // never subject to any of these).
        const idling =
          settledRef.current === null && !state.paused && !state.reducedMotion && state.onScreen;
        if (idling) {
          if (drift.current) return; // the compositor is already carrying it
          if (rotor.current) {
            write(
              position.current,
              wheelPointerDeflection(position.current, state.count, state.idleDirection)
            );
            drift.current = startIdleDrift(
              rotor.current,
              pointer.current,
              position.current,
              state.idleDirection,
              state.count
            );
            if (drift.current) return;
          }
          // No Web Animations here: the frame loop carries the drift itself.
          position.current += (elapsed / 1000) * IDLE_DEGREES_PER_SECOND * state.idleDirection;
          moving = true;
        } else settleDrift();
      }
      const direction = state.spinning ? 1 : state.idleDirection;
      write(
        position.current,
        moving ? wheelPointerDeflection(position.current, state.count, direction) : 0
      );
      // A wheel that is neither spinning nor drifting schedules nothing: no
      // frame callbacks, no style writes, until something wakes it.
      if ((run && state.spinning) || moving) frameHandle = requestAnimationFrame(animate);
    };
    wake.current = () => {
      if (frameHandle !== null) return;
      previous = performance.now();
      frameHandle = requestAnimationFrame(animate);
    };
    const visibility = () => {
      previous = performance.now();
      // A hidden tab freezes the drift where it is; the returning tab resumes it.
      if (document.hidden) settleDrift();
      wake.current();
    };
    document.addEventListener('visibilitychange', visibility);
    // Off screen, the drift stops where it is and the decorative lamps and
    // glows pause (data-offscreen). An owed spin keeps running regardless.
    let intersection: IntersectionObserver | null = null;
    if (frame.current && typeof IntersectionObserver !== 'undefined') {
      const target = frame.current;
      intersection = new IntersectionObserver((entries) => {
        // Several changes can queue between callbacks; only the newest is true.
        const latest = entries[entries.length - 1];
        if (!latest) return;
        live.current.onScreen = latest.isIntersecting;
        target.toggleAttribute('data-offscreen', !latest.isIntersecting);
        wake.current();
      });
      intersection.observe(target);
    }
    let media: MediaQueryList | null = null;
    const reduced = () => {
      live.current.reducedMotion = prefersReducedMotion();
      wake.current();
    };
    if (typeof window.matchMedia === 'function') {
      media = window.matchMedia('(prefers-reduced-motion: reduce)');
      media.addEventListener?.('change', reduced);
    }
    live.current.reducedMotion = prefersReducedMotion();
    wake.current();
    return () => {
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
      frameHandle = null;
      settleDrift();
      wake.current = () => {};
      document.removeEventListener('visibilitychange', visibility);
      intersection?.disconnect();
      media?.removeEventListener?.('change', reduced);
    };
  }, [settleDrift, write]);

  // A released hold or an unpaused wheel needs a frame to notice.
  useEffect(() => {
    wake.current();
  }, [hold, paused, spinning]);

  const assembled = presentation === 'assembly';
  const outerRing = assembled && upgraded;
  const outerRadius = outerRing ? 468 : 344;
  const innerRadius = outerRing ? (upgradeExpanded ? 204 : 334) : 88;
  const discRadius = outerRing ? 474 : 352;
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

  // Layer placement. The frame shows the aperture of the 1000-unit wheel
  // space (meet, centred); the stage is that whole space in CSS pixels, and
  // every layer inside it is positioned in wheel units times `unit`.
  const apertureWidth =
    fitViewport && box.height > 0 ? Math.max(360, (415 * box.width) / box.height) : 360;
  const view = aperture(presentation, upgraded, apertureWidth);
  const unit =
    box.width > 0 && box.height > 0 ? Math.min(box.width / view.w, box.height / view.h) : 0;
  const stageStyle: CSSProperties = {
    width: 1000 * unit,
    height: 1000 * unit,
    left: box.width / 2 - 500 * unit,
    top: (box.height - view.h * unit) / 2 - view.y * unit,
    transform: `scale(${faceScale})`,
  };
  const px = (units: number) => units * unit;
  const selectorShift = outerRing ? -124 : 0;
  const lamps = !assembled || upgraded;
  const lampRadius = outerRing ? 482 : 424;
  const hub = !outerRing;
  const winner = settledOrd === null ? -1 : arranged.findIndex((s) => s.ord === settledOrd);
  return (
    <div
      ref={frame}
      className={styles.frame}
      style={{ width: size, maxWidth: '100%' }}
      role="img"
      aria-label={upgraded ? 'Upgrade Wheel' : 'Diamond Wheel'}
      data-fit-viewport={fitViewport || undefined}
      data-motion="keep"
      data-phase={spinning ? 'spinning' : settledOrd === null ? 'idle' : 'landed'}
      data-upgraded={upgraded || undefined}
      data-idle-direction={idleDirection}
      data-presentation={presentation}
      data-prize-scale={(presentation === 'cabinet' || assembled) && !upgraded ? 2 : 1}
      data-wheel-unit={unit ? unit.toFixed(4) : undefined}
    >
      <div className={styles.aura} aria-hidden="true" />
      <div className={styles.stage} style={stageStyle} data-wheel-face aria-hidden="true">
        {/* The rotor: one composited layer that only ever changes its transform. */}
        <div
          ref={rotor}
          className={styles.rotor}
          data-wheel-rotor
          data-motion="keep"
          style={{
            left: px(500 - discRadius),
            top: px(500 - discRadius),
            width: px(2 * discRadius),
            height: px(2 * discRadius),
          }}
        >
          <svg
            viewBox={`${500 - discRadius} ${500 - discRadius} ${2 * discRadius} ${2 * discRadius}`}
            className={styles.layerSvg}
          >
            <defs>
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
            </defs>
            <circle cx="500" cy="500" r={discRadius} fill="#050607" />
            {arranged.map((segment, index) => {
              const start = index * step;
              const end = start + step;
              const won = settledOrd === segment.ord;
              return (
                <g
                  key={segment.ord}
                  className={`${materialClass(segment)} ${segment.locked ? styles.locked : ''}`}
                  data-slot={segment.ord}
                  data-winner={won || undefined}
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
                    stroke="#45adff"
                    strokeWidth="1"
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
          </svg>
        </div>
        {/* The winner's lit edge and its glow breathe on their own layer, held
            at the landed angle, so the rotor never repaints. The two wide
            strokes stand in for the drop-shadow filter the edge used to animate. */}
        {winner >= 0 && (
          <div
            className={styles.winnerGlow}
            data-winner-glow
            style={{ transform: `rotate(${settledAngle}deg)` }}
          >
            <svg viewBox="0 0 1000 1000" className={styles.layerSvg}>
              {(
                [
                  ['#45adff', 0.18, 18],
                  ['#45adff', 0.4, 9],
                  ['#f4f7fb', 1, 4],
                ] as const
              ).map(([stroke, opacity, width]) => (
                <path
                  key={width}
                  d={sector(
                    outerRadius - 16,
                    innerRadius + 17,
                    winner * step + 2.3,
                    (winner + 1) * step - 2.3
                  )}
                  fill="none"
                  stroke={stroke}
                  strokeOpacity={opacity}
                  strokeWidth={width}
                />
              ))}
            </svg>
          </div>
        )}
        {/* The housing, rim, hub and selector holder: static art, painted once. */}
        <svg
          viewBox="0 0 1000 1000"
          className={`${styles.layerSvg} ${styles.housing}`}
          data-wheel-static
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
            <linearGradient id={`${id}-hub-chrome`} x1="0" y1="0" x2="1" y2="1">
              <stop stopColor="#9aa5b3" />
              <stop offset=".4" stopColor="#9aa5b3" stopOpacity=".6" />
              <stop offset="1" stopColor="#050607" />
            </linearGradient>
            <radialGradient id={`${id}-hub-glass`} cx=".25" cy=".1" r=".9">
              <stop stopColor="#9aa5b3" stopOpacity=".35" />
              <stop offset=".3" stopColor="#050607" />
              <stop offset="1" stopColor="#000" />
            </radialGradient>
            {/* The hub's cast shadow, as a gradient rather than a live filter. */}
            <radialGradient id={`${id}-hub-shadow`}>
              <stop stopColor="#000" stopOpacity=".9" />
              <stop offset=".8" stopColor="#000" stopOpacity=".85" />
              <stop offset=".9" stopColor="#000" stopOpacity=".4" />
              <stop offset="1" stopColor="#000" stopOpacity="0" />
            </radialGradient>
          </defs>
          {(!assembled || upgraded) && (
            <image
              clipPath={outerRing ? `url(#${id}-outer-housing)` : undefined}
              href={`${ART}${outerRing ? 'wheel-matte-rim-v1.webp' : 'wheel-chrome-housing-v1.png'}`}
              x={outerRing ? -18 : 0}
              y={outerRing ? -18 : 0}
              width={outerRing ? 1036 : 1000}
              height={outerRing ? 1036 : 1000}
              pointerEvents="none"
            />
          )}
          {assembled && !upgraded && (
            <image
              href={`${ART}wheel-matte-rim-v1.webp`}
              x="64"
              y="64"
              width="872"
              height="872"
              clipPath={`url(#${id}-bearing)`}
              pointerEvents="none"
            />
          )}
          {hub && (
            <g>
              <circle cx="500" cy="508" r="118" fill={`url(#${id}-hub-shadow)`} />
              <circle cx="500" cy="500" r="102" fill={`url(#${id}-hub-chrome)`} />
              <circle cx="500" cy="500" r="91" fill="#050607" stroke="#45adff" strokeWidth="2" />
              <circle cx="500" cy="500" r="85" fill={`url(#${id}-hub-glass)`} />
              {/* Below the assembly aperture (y > 415 at every face scale): not drawn there. */}
              {!assembled && (
                <>
                  <svg x="437" y="433" width="126" height="118" className={styles.hubStone}>
                    <WheelPrizeArt segment={{ kind: upgraded ? 'upgrade' : 'diamonds' }} />
                  </svg>
                  <text x="500" y="568" className={styles.hubLabel} textAnchor="middle">
                    {upgraded ? 'UPGRADE' : 'Diamond Spins'}
                  </text>
                </>
              )}
            </g>
          )}
          {showSelector && (
            <g
              data-wheel-selector
              transform={outerRing ? `translate(0 ${selectorShift})` : undefined}
            >
              <image
                data-selector-holder
                href={`${ART}wheel-selector-holder-v2.webp`}
                x={SELECTOR.holder.x}
                y={SELECTOR.holder.y}
                width={SELECTOR.holder.w}
                height={(SELECTOR.holder.w * 310) / 520}
              />
            </g>
          )}
        </svg>
        {/* Lamps: one element each, opacity only, so the chase runs off the main thread. */}
        {lamps &&
          Array.from({ length: 48 }, (_, i) => {
            const [x, y] = point(lampRadius, i * 7.5);
            return (
              <i
                key={i}
                className={styles.lamp}
                style={{
                  left: px(x - 5),
                  top: px(y - 5),
                  width: px(10),
                  height: px(10),
                  animationDelay: `${i * -0.045}s`,
                }}
              />
            );
          })}
        {/* The pointer: its shadow and its lit frame are baked art, cross-faded by opacity. */}
        {showSelector && (
          <div
            ref={pointer}
            className={styles.pointer}
            data-selector-pointer
            style={{
              left: px(SELECTOR.pointer.x),
              top: px(SELECTOR.pointer.y + selectorShift),
              width: px(SELECTOR.pointer.w),
              height: px(SELECTOR.pointer.h),
              transformOrigin: `${px(SELECTOR.pivot[0] - SELECTOR.pointer.x)}px ${px(SELECTOR.pivot[1] - SELECTOR.pointer.y)}px`,
            }}
          >
            <img src={`${ART}wheel-selector-pointer-v2.webp`} alt="" draggable={false} />
            <img
              src={`${ART}wheel-selector-pointer-glow-v2.webp`}
              alt=""
              draggable={false}
              className={styles.pointerGlow}
            />
          </div>
        )}
      </div>
    </div>
  );
}
