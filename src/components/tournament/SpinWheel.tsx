/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN WHEEL — the multiplier draw (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * In a Spin, the draw IS the product. The poker is how the money gets
 * delivered; the three seconds where the wheel decides whether you are playing
 * for 2× or 100× is the reason anyone opens the format. Until now our Spins
 * simply appeared with a multiplier already stamped on them — the single most
 * exciting moment in the game was a number in a tournament name.
 *
 * ─── How the majors do it ───────────────────────────────────────────────────
 * PokerStars puts a spinning wheel at the centre of the table before the cards
 * are dealt; GGPoker runs a reel. Both share the same three-part grammar, and
 * it is the grammar rather than the shape that does the work:
 *
 *   1. ACCELERATE — fast enough that you cannot read it. You are not being
 *      shown information yet, you are being shown that it is out of anyone's
 *      hands.
 *   2. DECELERATE — slow enough to read the tiers going past, so you can see
 *      what you might have got. This is where the tension actually lives.
 *   3. NEAR-MISS — the pointer creeps past a big tier before settling. Both
 *      rooms do this and it is the single most important beat: landing on 2×
 *      having just crawled past 100× is a *story*, and landing on 2× flat is a
 *      shrug.
 *
 * ─── Honesty ────────────────────────────────────────────────────────────────
 * The result is decided by the SERVER (crypto-grade draw, see
 * TournamentRecurringService.rollSpinMultiplier) and handed to this component
 * as a fact. Nothing here influences the outcome — the wheel is told where to
 * stop and works backwards to get there.
 *
 * That matters for the near-miss too: we do not manufacture one. The wheel is
 * laid out so tiers alternate small/large, so passing close to a big number on
 * the way to a small one is a genuine property of the layout rather than a
 * staged tease. A fake near-miss is a slot-machine trick and this is a poker
 * room.
 *
 * ─── Shared in real time ────────────────────────────────────────────────────
 * All three seats see the same wheel land on the same value at the same moment,
 * because the multiplier is a server fact delivered to every client. No
 * client-side randomness anywhere in this file.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { fireVibration } from '../../utils/vibrationGate';
import './SpinWheel.css';

export interface SpinTier {
  multiplier: number;
  /** Relative weight. Only used to size the segment, never to pick a winner. */
  weight?: number;
}

export interface SpinWheelData {
  /** The SERVER's result. This component never decides it. */
  multiplier: number;
  /** One buy-in, so the wheel can show real money rather than a bare multiple. */
  buyIn: number;
  /** Tier ladder for this Spin type, biggest last. */
  tiers: SpinTier[];
  currency?: string;
  /** Names of the three players, shown while the wheel decides. */
  playerNames?: string[];
}

export interface SpinWheelProps {
  data: SpinWheelData | null;
  onDone: () => void;
  playSounds?: boolean;
}

type Phase = 'idle' | 'intro' | 'spinning' | 'settling' | 'result';

/** Default ladder — matches SPIN_BONUS_TIERS.standard. */
export const DEFAULT_SPIN_TIERS: SpinTier[] = [
  { multiplier: 2, weight: 76.1904 },
  { multiplier: 3, weight: 14.2857 },
  { multiplier: 5, weight: 5.7143 },
  { multiplier: 10, weight: 2.381 },
  { multiplier: 25, weight: 0.9524 },
  { multiplier: 50, weight: 0.381 },
  { multiplier: 100, weight: 0.0952 },
];

const INTRO_MS = 900;
const SPIN_MS = 4200;
const RESULT_MS = 4200;

/**
 * Order the tiers around the wheel so small and large ALTERNATE.
 *
 * Laid out in ladder order, every big multiplier sits next to another big one
 * and a 2× result never passes near anything exciting. Interleaving from both
 * ends of the ladder means the pointer genuinely travels past a big tier on its
 * way to most small ones — a real near-miss rather than a staged one.
 */
export function buildWheelOrder(tiers: SpinTier[]): SpinTier[] {
  const asc = [...tiers].sort((a, b) => a.multiplier - b.multiplier);
  const out: SpinTier[] = [];
  let lo = 0;
  let hi = asc.length - 1;
  while (lo <= hi) {
    out.push(asc[lo]);
    if (lo !== hi) out.push(asc[hi]);
    lo += 1;
    hi -= 1;
  }
  return out;
}

/** Tier styling band. Bigger prizes read hotter. */
export function tierClass(multiplier: number): string {
  if (multiplier >= 100) return 'sw--mega';
  if (multiplier >= 25) return 'sw--big';
  if (multiplier >= 5) return 'sw--mid';
  return 'sw--base';
}

export default function SpinWheel({ data, onDone, playSounds = true }: SpinWheelProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [rotation, setRotation] = useState(0);
  const [displayPrize, setDisplayPrize] = useState(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rafRef = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const order = useMemo(() => buildWheelOrder(data?.tiers ?? DEFAULT_SPIN_TIERS), [data?.tiers]);
  const segmentAngle = 360 / Math.max(1, order.length);

  /** Where the winning segment sits, and therefore where the wheel must stop. */
  const targetIndex = useMemo(() => {
    if (!data) return 0;
    const i = order.findIndex((t) => t.multiplier === data.multiplier);
    // An unknown multiplier must never crash the table — land on the nearest.
    if (i >= 0) return i;
    let best = 0;
    let bestDiff = Infinity;
    order.forEach((t, idx) => {
      const d = Math.abs(t.multiplier - data.multiplier);
      if (d < bestDiff) {
        bestDiff = d;
        best = idx;
      }
    });
    return best;
  }, [data, order]);

  const prize = data ? Math.round(data.buyIn * data.multiplier * 100) / 100 : 0;

  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (!data) {
      setPhase('idle');
      setRotation(0);
      setDisplayPrize(0);
      return;
    }

    const speed = getAnimationSpeed();
    const reduced = prefersReducedMotion();

    setPhase('intro');
    setRotation(0);
    setDisplayPrize(0);

    if (playSounds) {
      try {
        soundService.playSpinStart();
      } catch {
        /* audio is best-effort */
      }
    }

    // Work backwards from the server's answer: land the CENTRE of the winning
    // segment under the pointer at 12 o'clock, after a whole number of turns.
    // Six full turns is long enough to lose track of position — the point of
    // the accelerate phase — without outstaying its welcome.
    const TURNS = 6;
    const landing = 360 * TURNS - (targetIndex * segmentAngle + segmentAngle / 2);

    const introAt = (reduced ? 100 : INTRO_MS) * speed;
    const spinFor = (reduced ? 400 : SPIN_MS) * speed;

    const toSpin = setTimeout(() => {
      setPhase('spinning');
      setRotation(landing);
      if (playSounds) {
        try {
          soundService.playSpinTicking(spinFor);
        } catch {
          /* best effort */
        }
      }
    }, introAt);

    const toSettle = setTimeout(() => setPhase('settling'), introAt + spinFor - 260 * speed);

    const toResult = setTimeout(() => {
      setPhase('result');
      if (playSounds) {
        try {
          soundService.playSpinMultiplierResult(data.multiplier);
        } catch {
          /* best effort */
        }
      }
      fireVibration(data.multiplier >= 25 ? [50, 30, 80] : [25, 20, 40]);

      // Count the PRIZE up, not the multiplier. "You are playing for $30" is
      // the fact that matters; the multiple is how it was arrived at.
      if (reduced) {
        setDisplayPrize(prize);
      } else {
        const started = performance.now();
        const durationMs = 900 * speed;
        const step = (now: number) => {
          const t = Math.min(1, (now - started) / durationMs);
          const eased = 1 - Math.pow(1 - t, 3);
          setDisplayPrize(Math.round(prize * eased * 100) / 100);
          if (t < 1) {
            rafRef.current = requestAnimationFrame(step);
          } else {
            rafRef.current = null;
            setDisplayPrize(prize);
          }
        };
        rafRef.current = requestAnimationFrame(step);
      }
    }, introAt + spinFor);

    const toEnd = setTimeout(
      () => {
        setPhase('idle');
        onDoneRef.current();
      },
      introAt + spinFor + (reduced ? 1800 : RESULT_MS) * speed
    );

    timersRef.current = [toSpin, toSettle, toResult, toEnd];
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [data, playSounds, targetIndex, segmentAngle, prize]);

  if (!data || phase === 'idle') return null;

  const currency = data.currency ?? '';
  const spinning = phase === 'spinning' || phase === 'settling';
  const won = order[targetIndex];

  return (
    <div
      className={`sw sw--${phase} ${tierClass(data.multiplier)}`}
      role="dialog"
      aria-modal="true"
      aria-label="Spin multiplier draw"
    >
      <div className="sw__backdrop" />

      <div className="sw__stage">
        <div className="sw__eyebrow">PRIZE POOL</div>

        {data.playerNames && data.playerNames.length > 0 && (
          <div className="sw__players">{data.playerNames.join('  ·  ')}</div>
        )}

        {/* ── The wheel ── */}
        <div className="sw__wheel-wrap">
          <div className="sw__glow" aria-hidden="true" />

          {/* Pointer at 12 o'clock. It flicks as segments pass beneath it. */}
          <div className={`sw__pointer${spinning ? ' sw__pointer--live' : ''}`} aria-hidden="true">
            <span className="sw__pointer-tip" />
          </div>

          <div
            className="sw__wheel"
            style={{
              transform: `rotate(${rotation}deg)`,
              // The whole illusion is in this curve: a long fast middle and a
              // very slow tail, so the last few segments crawl past and can be
              // read. A plain ease-out stops being interesting halfway through.
              transitionDuration: `${(phase === 'intro' ? 0 : SPIN_MS) * getAnimationSpeed()}ms`,
            }}
            aria-hidden="true"
          >
            {order.map((tier, i) => (
              <div
                key={`${tier.multiplier}-${i}`}
                className={`sw__seg ${tierClass(tier.multiplier)}`}
                style={{
                  ['--sw-i' as string]: i,
                  ['--sw-angle' as string]: `${segmentAngle}deg`,
                  transform: `rotate(${i * segmentAngle}deg)`,
                }}
              >
                <span className="sw__seg-label">{tier.multiplier}×</span>
              </div>
            ))}
            <div className="sw__hub" />
          </div>
        </div>

        {/* ── Status / result ── */}
        {phase !== 'result' ? (
          <div className="sw__status">
            <span className="sw__status-main">
              {phase === 'intro' ? 'Drawing your prize pool' : 'Spinning'}
              <span className="sw__dots">
                <i />
                <i />
                <i />
              </span>
            </span>
            <span className="sw__status-sub">
              {currency}
              {data.buyIn.toLocaleString()} buy-in · winner takes the pool
            </span>
          </div>
        ) : (
          <div className="sw__result">
            <div className="sw__mult">{won?.multiplier ?? data.multiplier}×</div>
            <div className="sw__prize">
              {currency}
              {displayPrize.toLocaleString(undefined, {
                minimumFractionDigits: prize % 1 === 0 ? 0 : 2,
                maximumFractionDigits: 2,
              })}
            </div>
            <div className="sw__prize-label">PRIZE POOL</div>
            {data.multiplier >= 25 && (
              <div className="sw__hype">
                {data.multiplier >= 100 ? 'MEGA JACKPOT' : 'JACKPOT SPIN'}
              </div>
            )}
          </div>
        )}
      </div>

      {phase === 'result' && data.multiplier >= 25 && (
        <div className="sw__confetti" aria-hidden="true">
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} className="sw__conf" style={{ ['--sw-c' as string]: i }} />
          ))}
        </div>
      )}
    </div>
  );
}
