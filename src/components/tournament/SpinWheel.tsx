/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN-IT INTRO — the multiplier draw, PokerBros grammar (2026-08-20, v2)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Rebuilt against frame-by-frame study of Dan's PokerBros reference capture
 * ("spin it intro.MOV", 17.7s). Their sequence, beat by beat:
 *
 *   1. The TABLE STAYS VISIBLE. No full-screen takeover: the felt dims and a
 *      spotlight beam falls from the top of the screen onto the table.
 *   2. A big gold COUNTDOWN (3·2·1) pops centre-felt.
 *   3. A gold-rimmed DISC sits on the felt — a pie of coloured segments with
 *      the format wordmark in the hub. It does NOT rotate: the segments
 *      LIGHT UP one at a time, a chase that runs fast and decelerates, each
 *      lit segment fading behind the runner.
 *   4. The chase settles on the winner. That segment stays lit and flashes;
 *      every other segment desaturates to grey.
 *   5. The disc fades away, the table brightens, and the masthead now carries
 *      the prize pool.
 *
 * The chase reads better than a rotating wheel at table scale — nothing
 * spins under a pointer, so there is no moment where the eye loses the
 * geometry — and the decelerating runner gives the same genuine near-miss:
 * it walks THROUGH the big tiers on its way to the result.
 *
 * ─── Honesty (unchanged from v1) ────────────────────────────────────────────
 * The result is decided by the SERVER (reserve-gated draw at game start) and
 * handed to this component as a fact. No Math.random touches the outcome —
 * the chase is told where to stop and works backwards to get there. Locked
 * tiers (Reserve Pool cannot fund them) render dark with their unlock note;
 * the engine excluded them from the draw, so the chase can pass over them
 * but never end on one.
 *
 * All three seats watch the same chase land on the same segment at the same
 * moment, because the multiplier is a server fact delivered to every client.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { fireVibration } from '../../utils/vibrationGate';
import { SPIN_TIERS, spinTier } from '../../config/spinSpec';
import './SpinWheel.css';

export interface SpinTier {
  multiplier: number;
  /** Relative weight. Only used for ordering context, never to pick a winner. */
  weight?: number;
}

export interface SpinWheelData {
  /** The SERVER's result. This component never decides it. */
  multiplier: number;
  /** One buy-in, so the disc can show real money rather than a bare multiple. */
  buyIn: number;
  /** Tier ladder for this Spin type, biggest last. */
  tiers: SpinTier[];
  currency?: string;
  /** Names of the three players, shown while the chase decides. */
  playerNames?: string[];
  /**
   * Multipliers the Reserve Pool cannot currently fund. Shown on the disc as
   * LOCKED rather than hidden: a visible 500x you cannot win yet is
   * anticipation and is honest about the ceiling. The engine excludes these
   * from the draw entirely, so a locked tier can never be the result.
   */
  lockedMultipliers?: number[];
  /**
   * The same information with the reason and the unlock threshold attached,
   * exactly as `fn_spin_draw_multiplier` recorded it for THIS draw. Preferred
   * over `lockedMultipliers` when present.
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

type Phase = 'idle' | 'countdown' | 'chase' | 'result';

/**
 * The ladder shown on the disc, derived from the canonical spec so the disc
 * can never advertise a tier the engine cannot draw (or omit one it can).
 */
export const DEFAULT_SPIN_TIERS: SpinTier[] = SPIN_TIERS.map((t) => ({
  multiplier: t.multiplier,
  weight: t.freq,
}));

// ── Timing (PokerBros reference: ~10s countdown-to-fade) ────────────────────
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 750;
const CHASE_MS = 4200;
/** Chase loops before the runner starts caring where it lands. */
const CHASE_LOOPS = 3;
const RESULT_MS = 4200;

/**
 * Order the tiers around the disc so small and large ALTERNATE.
 *
 * Laid out in ladder order, every big multiplier sits next to another big one
 * and a 2x result never passes near anything exciting. Interleaving from both
 * ends of the ladder means the chase runner genuinely walks through a big
 * tier on its way to most small ones — a real near-miss, not a staged one.
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
 * The column is jsonb and PostgREST may hand it back as a parsed array or a
 * string, and it is NULL on every Spin created before the column existed.
 * Anything unrecognisable yields an empty list: a disc that fails to dim a
 * segment is a small loss, and a disc that throws while a player is watching
 * their prize be decided is a large one.
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

/**
 * Chase schedule: when (ms from chase start) each step fires. Ease-out — the
 * runner sprints its early laps and crawls the final segments, so the last
 * few are readable one at a time exactly like the reference. The LAST step is
 * the target segment by construction.
 */
export function chaseSchedule(
  segmentCount: number,
  targetIndex: number,
  totalMs: number
): number[] {
  const n = Math.max(1, segmentCount);
  const steps = CHASE_LOOPS * n + ((targetIndex % n) + 1);
  const times: number[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Convex curve: step TIMES cluster early and spread late, so the gaps
    // between steps strictly grow — the runner sprints its opening laps and
    // crawls the final segments one readable beat at a time.
    times.push(Math.round(totalMs * Math.pow(t, 2.6)));
  }
  return times;
}

export default function SpinWheel({ data, onDone, playSounds = true }: SpinWheelProps) {
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
   * among the locked tiers that told us one. "500x unlocks at 5,000" is
   * anticipation; a bare dimmed segment is just an absence.
   */
  const nextUnlock = useMemo(() => {
    const withThreshold = [...lockedDetail.values()].filter(
      (t) => Number.isFinite(t.unlocksAt) && (t.unlocksAt as number) > 0
    );
    if (withThreshold.length === 0) return null;
    return withThreshold.sort((a, b) => (a.unlocksAt as number) - (b.unlocksAt as number))[0];
  }, [lockedDetail]);

  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(COUNTDOWN_FROM);
  /** Index of the currently lit segment; -1 = nothing lit yet. */
  const [litIndex, setLitIndex] = useState(-1);
  const [displayPrize, setDisplayPrize] = useState(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rafRef = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const order = useMemo(() => buildWheelOrder(data?.tiers ?? DEFAULT_SPIN_TIERS), [data?.tiers]);
  const segmentAngle = 360 / Math.max(1, order.length);

  /** Where the winning segment sits — where the chase must stop. */
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
      setLitIndex(-1);
      setCount(COUNTDOWN_FROM);
      setDisplayPrize(0);
      return;
    }

    const speed = getAnimationSpeed();
    const reduced = prefersReducedMotion();
    const timers: ReturnType<typeof setTimeout>[] = [];

    setPhase('countdown');
    setCount(COUNTDOWN_FROM);
    setLitIndex(-1);
    setDisplayPrize(0);

    if (playSounds) {
      try {
        soundService.playSpinStart();
      } catch {
        /* audio is best-effort */
      }
    }

    // ── 1. Countdown: 3 · 2 · 1 ─────────────────────────────────────────────
    const countdownMs = (reduced ? 200 : COUNTDOWN_FROM * COUNTDOWN_STEP_MS) * speed;
    if (!reduced) {
      for (let c = COUNTDOWN_FROM - 1; c >= 1; c--) {
        timers.push(
          setTimeout(() => setCount(c), (COUNTDOWN_FROM - c) * COUNTDOWN_STEP_MS * speed)
        );
      }
    }

    // ── 2. The chase ────────────────────────────────────────────────────────
    const chaseMs = (reduced ? 400 : CHASE_MS) * speed;
    timers.push(
      setTimeout(() => {
        setPhase('chase');
        if (playSounds) {
          try {
            // The ticking is scheduled on the same deceleration curve as the
            // chase steps, so the sound slows with the light.
            soundService.playSpinTicking(chaseMs);
          } catch {
            /* best effort */
          }
        }
        if (reduced) {
          setLitIndex(targetIndex);
        } else {
          const schedule = chaseSchedule(order.length, targetIndex, chaseMs);
          schedule.forEach((at, stepIdx) => {
            timers.push(setTimeout(() => setLitIndex(stepIdx % order.length), at));
          });
        }
      }, countdownMs)
    );

    // ── 3. Result ───────────────────────────────────────────────────────────
    timers.push(
      setTimeout(() => {
        setPhase('result');
        setLitIndex(targetIndex);
        if (playSounds) {
          try {
            soundService.playSpinMultiplierResult(data.multiplier);
          } catch {
            /* best effort */
          }
        }
        fireVibration(data.multiplier >= 25 ? [50, 30, 80] : [25, 20, 40]);

        // Count the PRIZE up, not the multiplier. "You are playing for $30"
        // is the fact that matters; the multiple is how it was arrived at.
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
      }, countdownMs + chaseMs)
    );

    // ── 4. Fade out, hand the felt back ────────────────────────────────────
    timers.push(
      setTimeout(
        () => {
          setPhase('idle');
          onDoneRef.current();
        },
        countdownMs + chaseMs + (reduced ? 1800 : RESULT_MS) * speed
      )
    );

    timersRef.current = timers;
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [data, playSounds, targetIndex, order.length, prize]);

  if (!data || phase === 'idle') return null;

  const currency = data.currency ?? '';
  const won = order[targetIndex];

  return (
    <div
      className={`sw sw--${phase} ${tierClass(data.multiplier)}`}
      role="dialog"
      aria-modal="true"
      aria-label="Spin multiplier draw"
    >
      {/* The table stays visible: a vignette dims it and a spotlight beam
          falls from the top of the screen, exactly like the reference. */}
      <div className="sw__dim" />
      <div className="sw__beam" aria-hidden="true" />

      <div className="sw__stage">
        {phase === 'countdown' && (
          <div className="sw__count" key={count} aria-hidden="true">
            {count}
          </div>
        )}

        {(phase === 'chase' || phase === 'result') && (
          <div className="sw__disc-wrap">
            <div className={`sw__disc${phase === 'result' ? ' sw__disc--settled' : ''}`}>
              {order.map((tier, i) => {
                const isLit = i === litIndex;
                // The segment the runner JUST left keeps a fading ember, so
                // the chase reads as motion rather than a blinking light.
                const wasLit =
                  phase === 'chase' &&
                  litIndex >= 0 &&
                  i === (litIndex - 1 + order.length) % order.length;
                const isWinner = phase === 'result' && i === targetIndex;
                return (
                  <div
                    key={`${tier.multiplier}-${i}`}
                    className={[
                      'sw__seg',
                      `sw__seg--c${i % 9}`,
                      isLit ? 'sw__seg--lit' : '',
                      wasLit ? 'sw__seg--trail' : '',
                      isWinner ? 'sw__seg--winner' : '',
                      phase === 'result' && !isWinner ? 'sw__seg--spent' : '',
                      locked.has(tier.multiplier) ? 'sw__seg--locked' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
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
                    <span className="sw__seg-label">{tier.multiplier}</span>
                  </div>
                );
              })}
              <div className="sw__hub">
                {phase === 'result' ? (
                  <span className="sw__hub-mult">{won?.multiplier ?? data.multiplier}×</span>
                ) : (
                  <span className="sw__hub-brand">SPIN-IT</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Below the disc ── */}
        {phase === 'chase' && (
          <div className="sw__status">
            <span className="sw__status-sub">
              {currency}
              {data.buyIn.toLocaleString()} buy-in
            </span>
            {nextUnlock && (
              <span className="sw__status-locked">
                {nextUnlock.multiplier}× unlocks when the club reserve reaches {currency}
                {(nextUnlock.unlocksAt as number).toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </span>
            )}
          </div>
        )}

        {phase === 'result' && (
          <div className="sw__result">
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
