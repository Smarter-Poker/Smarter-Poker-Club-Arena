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
import { SPIN_TIERS, spinTier } from '../../config/spinSpec';
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
  /**
   * Multipliers the Reserve Pool cannot currently fund. They are shown on the
   * wheel as LOCKED rather than hidden: a visible 500x you cannot win yet is
   * anticipation and is honest about the format, where silently shrinking the
   * wheel makes the ceiling look lower than it is.
   *
   * The engine excludes these from the draw entirely, so a locked tier can
   * never be the result.
   */
  lockedMultipliers?: number[];
  /**
   * The same information with the reason and the unlock threshold attached,
   * exactly as `fn_spin_draw_multiplier` recorded it for THIS draw. Preferred
   * over `lockedMultipliers` when present, because "500x unlocks at 5,000" is
   * anticipation where a bare dimmed segment is just an absence.
   *
   * `reason` is 'unaffordable' (the pool plus this game's own contribution
   * cannot cover the prize) or 'threshold' (affordable, but not yet backed by
   * the required multiple of its own jackpot at the biggest stake running).
   */
  lockedTiers?: SpinLockedTier[];
}

export interface SpinLockedTier {
  multiplier: number;
  reason?: string;
  /** Reserve balance at which this tier becomes drawable. */
  unlocksAt?: number;
}

export interface SpinWheelProps {
  data: SpinWheelData | null;
  onDone: () => void;
  playSounds?: boolean;
}

type Phase = 'idle' | 'intro' | 'spinning' | 'settling' | 'result';

/**
 * The ladder shown on the wheel, derived from the canonical spec so the wheel
 * can never advertise a tier the engine cannot draw (or omit one it can).
 */
export const DEFAULT_SPIN_TIERS: SpinTier[] = SPIN_TIERS.map((t) => ({
  multiplier: t.multiplier,
  weight: t.freq,
}));

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

/**
 * Read `tournaments.spin_locked_tiers` into the shape this component wants.
 *
 * The column is jsonb and PostgREST may hand it back as a parsed array or, in
 * some client configurations, as a string. It is also NULL on every Spin
 * created before the column existed. Anything unrecognisable yields an empty
 * list: a wheel that fails to dim a segment is a small loss, and a wheel that
 * throws while a player is watching their prize be decided is a large one.
 */
export function parseLockedTiers(raw: unknown): SpinLockedTier[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: SpinLockedTier[] = [];
  for (const entry of value) {
    const multiplier = Number((entry as any)?.multiplier);
    if (!Number.isFinite(multiplier)) continue;
    const unlocksAt = Number((entry as any)?.unlocksAt);
    out.push({
      multiplier,
      reason: (entry as any)?.reason ? String((entry as any).reason) : undefined,
      unlocksAt: Number.isFinite(unlocksAt) && unlocksAt > 0 ? unlocksAt : undefined,
    });
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
  /**
   * `lockedTiers` wins when both are given — it is the richer form of the same
   * fact. `lockedMultipliers` stays supported so a caller with only the bare
   * numbers still dims the right segments.
   */
  const lockedDetail = useMemo(() => {
    const map = new Map<number, SpinLockedTier>();
    for (const m of data?.lockedMultipliers ?? []) map.set(m, { multiplier: m });
    for (const t of data?.lockedTiers ?? []) {
      if (Number.isFinite(t?.multiplier)) map.set(t.multiplier, t);
    }
    return map;
  }, [data?.lockedMultipliers, data?.lockedTiers]);

  const locked = useMemo(() => new Set(lockedDetail.keys()), [lockedDetail]);

  /**
   * The cheapest unlock we can honestly advertise: the smallest threshold
   * among the locked tiers that told us one. Shown while the wheel decides,
   * where it reads as "there is more on this wheel than you can win today" —
   * which is true, and is the strongest thing this format has to say.
   */
  const nextUnlock = useMemo(() => {
    const withThreshold = [...lockedDetail.values()].filter(
      (t) => Number.isFinite(t.unlocksAt) && (t.unlocksAt as number) > 0
    );
    if (withThreshold.length === 0) return null;
    return withThreshold.sort((a, b) => (a.unlocksAt as number) - (b.unlocksAt as number))[0];
  }, [lockedDetail]);
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
                className={`sw__seg ${tierClass(tier.multiplier)}${
                  locked.has(tier.multiplier) ? ' sw__seg--locked' : ''
                }`}
                style={{
                  ['--sw-i' as string]: i,
                  ['--sw-angle' as string]: `${segmentAngle}deg`,
                  transform: `rotate(${i * segmentAngle}deg)`,
                }}
                title={
                  lockedDetail.get(tier.multiplier)?.unlocksAt
                    ? `${tier.multiplier}x unlocks at a ${currency}${Number(
                        lockedDetail.get(tier.multiplier)!.unlocksAt
                      ).toLocaleString(undefined, { maximumFractionDigits: 0 })} reserve`
                    : undefined
                }
              >
                <span className="sw__seg-label">
                  {tier.multiplier}×{locked.has(tier.multiplier) ? ' \u00B7' : ''}
                </span>
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
            {/* An honest note about the ceiling. A dimmed segment on its own
                just looks like an absence; naming the number it unlocks at
                turns it into something to come back for, and states plainly
                that it is not in play right now rather than implying it is. */}
            {nextUnlock && (
              <span className="sw__status-locked">
                {nextUnlock.multiplier}× unlocks when the club reserve reaches {currency}
                {(nextUnlock.unlocksAt as number).toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </span>
            )}
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

            {/* Who actually cashes. At 2x-5x only the winner does, and saying
                so up front is kinder than letting second place find out at the
                end of a three-minute tournament. */}
            <div className="sw__splits">
              {(spinTier(data.multiplier)?.payouts ?? [1]).map((pct, i) => (
                <span key={i} className="sw__split">
                  <span className="sw__split-place">
                    {['1st', '2nd', '3rd'][i] ?? `${i + 1}th`}
                  </span>
                  <span className="sw__split-amt">
                    {currency}
                    {(Math.round(prize * pct * 100) / 100).toLocaleString()}
                  </span>
                </span>
              ))}
            </div>
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
