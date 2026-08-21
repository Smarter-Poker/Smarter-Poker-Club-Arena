/**
 * =================================================================================
 *  THROW ANIMATION -- Dynamic 3D Throwable Display (2026-08-20, v2)
 * =================================================================================
 *
 * PokerBros-style multi-phase throw choreography, driven entirely by the
 * per-item metadata in ThrowableService (physics / impact / sound / weight /
 * linger / colors / spin):
 *
 *   WINDUP  (140ms)  item pops + scales up at the thrower's seat
 *   FLIGHT  (420-1100ms, per physics) parabola / fastball / lob / float /
 *                    drop-from-above / S-curve swoop / corkscrew spiral,
 *                    with tumble spin, velocity tilt and a motion trail
 *   IMPACT  (~820ms) per-profile FX: splat goo, liquid splash, elastic
 *                    bounce, dust thud, fireball explosion + smoke, shard
 *                    shatter, electric zap, glitter sparkle, confetti
 *                    burst -- plus squash-and-stretch, shockwave ring,
 *                    particle scatter, target-seat flinch, screen shake
 *   LINGER  (2.5s)   stain/scorch residue for messy items
 *
 * AUDIO -- owned HERE, not by the send/receive hooks: launch whoosh at
 * flight start, optional per-item travel sound (bomb fuse, rocket engine,
 * ufo hover...) spanning the flight, and the item-specific SFX exactly on
 * landing -- for the thrower AND every receiving client. All SFX are
 * stereo-panned to where the impact happens on screen.
 *
 * BLEND NOTE -- the 49 renders are opaque JPGs on pure black, erased by
 * mix-blend-mode: screen. That also means CSS drop-shadow() is USELESS on
 * them (it keys off the alpha channel, and a JPG's alpha is a solid
 * rectangle -- the "shadow" would be a glowing box). All glow here comes
 * from separate radial-gradient layers that are themselves screen-blended,
 * so they read as additive light and cost nothing over dark felt.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { ThrowEvent } from '../../services/ThrowableService';
import type { ThrowPhysics } from '../../services/ThrowableService';
import { throwableSoundService } from '../../services/ThrowableSoundService';
import { ThrowableImage } from './ThrowableImage';
import './ThrowAnimation.css';
// Per-item signature FX -- MUST load after ThrowAnimation.css so its
// equal-specificity overrides win the cascade.
import './ThrowableSignatures.css';

// =================================================================================
// TIMING (ms)
// =================================================================================

const WINDUP_DURATION = 140;
const IMPACT_DURATION = 820;
const LINGER_DURATION = 2500;

/** Flight duration + arc height per physics profile */
const PHYSICS: Record<ThrowPhysics, { duration: number; arc: number }> = {
  arc: { duration: 650, arc: 90 },
  fastball: { duration: 420, arc: 18 },
  lob: { duration: 950, arc: 170 },
  float: { duration: 1100, arc: 46 },
  drop: { duration: 780, arc: 210 },
  swoop: { duration: 880, arc: 70 },
  spiral: { duration: 760, arc: 80 },
};

/** Particle counts per impact profile */
const PARTICLES: Record<string, number> = {
  splat: 12,
  splash: 14,
  bounce: 0,
  thud: 8,
  explode: 16,
  shatter: 10,
  zap: 8,
  sparkle: 10,
  burst: 16,
};

/** Projectile size per weight -- an anvil should LOOK heavier than a tennis ball */
const FLIGHT_SIZE: Record<string, number> = { light: 42, medium: 48, heavy: 58 };
const IMPACT_SIZE: Record<string, number> = { light: 56, medium: 64, heavy: 76 };

/**
 * Per-item flight-duration overrides (ms) -- a tennis serve and a lightning
 * strike should not share the leisurely pace of their physics profile.
 */
const DURATION_OVERRIDES: Record<string, number> = {
  tennis_ball: 330,
  lightning_bolt: 260,
  rocket: 400,
  magnet: 360,
  boxing_glove: 380,
};

/**
 * Items whose flight telegraphs the TARGET (rendered at the impact point
 * DURING flight): the anvil's growing cartoon shadow, the lightning strike
 * warning glow. Everything else renders no target FX.
 */
const TARGET_TELEGRAPH = new Set(['anvil', 'lightning_bolt', 'bomb']);

/** Normalized stereo position (-1..1) for a screen x coordinate. */
function panForX(x: number): number {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  if (!w) return 0;
  return Math.max(-0.8, Math.min(0.8, (x / w) * 2 - 1));
}

// =================================================================================
// SINGLE THROW ANIMATION
// =================================================================================

interface ThrowAnimationProps {
  event: ThrowEvent;
  seatPositions: Map<number, { x: number; y: number }>;
  onComplete: () => void;
}

interface ParticleSpec {
  angle: number;
  dist: number;
  size: number;
  delay: number;
  useAlt: boolean;
}

export function ThrowAnimation({ event, seatPositions, onComplete }: ThrowAnimationProps) {
  const [phase, setPhase] = useState<'windup' | 'flight' | 'impact' | 'linger' | 'done'>('windup');

  const toPos = seatPositions.get(event.toSeat);
  // ACCURACY FIX (per-item pass): an unseated thrower (railbird, or a seat
  // the receiving client could not resolve) arrives as fromSeat 0, which has
  // no position -- the throw used to be charged, broadcast, and then render
  // NOTHING. Synthesize a launch point below the target instead, so every
  // paid throw is seen by everyone.
  const fromPos =
    seatPositions.get(event.fromSeat) || (toPos ? { x: toPos.x, y: toPos.y + 240 } : undefined);

  const t = event.throwable;
  const basePhysics = PHYSICS[t.physics] || PHYSICS.arc;
  const physics = DURATION_OVERRIDES[t.id]
    ? { ...basePhysics, duration: DURATION_OVERRIDES[t.id] }
    : basePhysics;
  const isHeavy = t.weight === 'heavy';
  const flightSize = FLIGHT_SIZE[t.weight] || 48;
  const impactSize = IMPACT_SIZE[t.weight] || 64;

  // Velocity tilt: fast, spinless items lean into their line of travel
  // (rocket, water gun, boxing glove...). Fraction of the true angle so an
  // unknown render orientation can never point completely the wrong way.
  const travelTilt = useMemo(() => {
    if (!fromPos || !toPos) return 0;
    if (t.physics !== 'fastball' && t.physics !== 'swoop') return 0;
    const deg = (Math.atan2(toPos.y - fromPos.y, toPos.x - fromPos.x) * 180) / Math.PI;
    return deg * (t.physics === 'fastball' ? 0.35 : 0.2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  // UI-AUDIT #1 (kept from the previous system): the container passes a new
  // `() => handleComplete(event.id)` arrow on every render. Keeping onComplete
  // in effect deps cleared and restarted the phase timers on each table
  // re-render -- projectiles could fly forever. Ref it.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    const launchPan = fromPos ? panForX(fromPos.x) : 0;
    const impactPan = toPos ? panForX(toPos.x) : 0;

    // WINDUP -> FLIGHT (launch whoosh + optional travel sound)
    at(WINDUP_DURATION, () => {
      setPhase('flight');
      try {
        throwableSoundService.playLaunch(t.weight, launchPan);
        throwableSoundService.playFlight(t.id, physics.duration, impactPan);
      } catch {
        /* audio is best-effort */
      }
    });

    // FLIGHT -> IMPACT (item SFX + seat flinch + shake)
    at(WINDUP_DURATION + physics.duration, () => {
      setPhase('impact');
      try {
        throwableSoundService.playImpact(t.sound, t.weight, impactPan);
      } catch {
        /* audio is best-effort */
      }

      // Target seat flinches (SeatSlot exposes data-seat-num)
      try {
        const seatEl = document.querySelector(`[data-seat-num="${event.toSeat}"]`);
        if (seatEl) {
          seatEl.classList.add('seat--throw-flinch');
          setTimeout(() => seatEl.classList.remove('seat--throw-flinch'), 500);
        }
      } catch {
        /* flinch is decorative */
      }

      if (isHeavy) {
        // v2 FIX: the old selector list (.poker-table, .table-layout,
        // [data-table]) matched NOTHING in the real DOM -- heavy impacts
        // never shook the screen. The animation container mounts inside
        // .table-scaler, which is the element the seats render in.
        const table = document.querySelector(
          '.table-scaler, .poker-table, .table-layout, [data-table]'
        );
        if (table) {
          table.classList.add('throw-animation--shake');
          setTimeout(() => table.classList.remove('throw-animation--shake'), 450);
        }
      }
    });

    // IMPACT -> LINGER or DONE
    at(WINDUP_DURATION + physics.duration + IMPACT_DURATION, () => {
      if (t.linger) {
        setPhase('linger');
      } else {
        setPhase('done');
        onCompleteRef.current();
      }
    });

    // LINGER -> DONE
    if (t.linger) {
      at(WINDUP_DURATION + physics.duration + IMPACT_DURATION + LINGER_DURATION, () => {
        setPhase('done');
        onCompleteRef.current();
      });
    }

    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  // Randomized particle scatter, stable per event
  const particles = useMemo<ParticleSpec[]>(() => {
    const count = PARTICLES[t.impact] ?? 10;
    return Array.from({ length: count }, (_, i) => ({
      angle: (360 / count) * i + (Math.random() * 24 - 12),
      dist: 34 + Math.random() * 46,
      size: 5 + Math.random() * 7,
      delay: Math.random() * 0.08,
      useAlt: i % 2 === 1,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  if (!fromPos || !toPos || phase === 'done') {
    return null;
  }

  const colorVars = {
    '--c1': t.color,
    '--c2': t.color2 || t.color,
  } as React.CSSProperties;

  return (
    <div className="throw-animation" data-throwable={t.id} style={colorVars}>
      {/* WINDUP -- pop at the thrower's seat */}
      {phase === 'windup' && (
        <div className="throw-animation__windup" style={{ left: fromPos.x, top: fromPos.y }}>
          <div className="throw-animation__glow" />
          <ThrowableImage throwableId={t.id} size={Math.round(flightSize * 0.92)} />
        </div>
      )}

      {/* FLIGHT -- target telegraph (anvil shadow / strike warning) */}
      {phase === 'flight' && TARGET_TELEGRAPH.has(t.id) && (
        <div
          className="throw-animation__fxt"
          style={
            {
              left: toPos.x,
              top: toPos.y,
              '--flight-dur': `${physics.duration}ms`,
            } as React.CSSProperties
          }
        />
      )}

      {/* FLIGHT -- physics-profiled trajectory with spin, tilt + trail */}
      {phase === 'flight' && (
        <div
          className={`throw-animation__projectile throw-animation__projectile--${t.physics}`}
          style={
            {
              '--from-x': `${fromPos.x}px`,
              '--from-y': `${fromPos.y}px`,
              '--to-x': `${toPos.x}px`,
              '--to-y': `${toPos.y}px`,
              '--flight-dur': `${physics.duration}ms`,
              '--arc-height': `${physics.arc}px`,
              '--spin': `${t.spin}deg`,
              '--tilt': `${travelTilt}deg`,
              '--size': `${flightSize}px`,
              '--half': `${flightSize / 2}px`,
            } as React.CSSProperties
          }
        >
          {/* trail ghosts (staggered, fading copies) */}
          <div className="throw-animation__trail throw-animation__trail--1">
            <ThrowableImage throwableId={t.id} size={flightSize} />
          </div>
          <div className="throw-animation__trail throw-animation__trail--2">
            <ThrowableImage throwableId={t.id} size={flightSize} />
          </div>
          <div className="throw-animation__spinner">
            <div className="throw-animation__glow throw-animation__glow--flight" />
            <div className="throw-animation__tilt">
              {/* per-item flight signature (rocket flame, bomb fuse spark,
                  water stream, feathers... display:none unless the item's
                  data-throwable CSS block turns it on) */}
              <div className="throw-animation__fxf" />
              <ThrowableImage throwableId={t.id} size={flightSize} />
            </div>
          </div>
        </div>
      )}

      {/* IMPACT -- per-profile FX at the target seat */}
      {phase === 'impact' && (
        <div
          className={`throw-animation__impact throw-animation__impact--${t.impact}`}
          style={{ left: toPos.x, top: toPos.y }}
        >
          {/* explosion flash / fireball / smoke layers (CSS-gated by profile) */}
          <div className="throw-animation__flash" />
          <div className="throw-animation__fireball" />
          <div className="throw-animation__smoke throw-animation__smoke--1" />
          <div className="throw-animation__smoke throw-animation__smoke--2" />
          <div className="throw-animation__smoke throw-animation__smoke--3" />

          {/* squash-and-stretch item with additive glow */}
          <div className="throw-animation__impact-glow" />
          <div className="throw-animation__impact-icon">
            <ThrowableImage throwableId={t.id} size={impactSize} />
          </div>

          {/* shockwave ring */}
          <div className="throw-animation__burst" />

          {/* per-item impact signature (frost ring, bite marks, claw slashes,
              steam, petals, pins, cork, magic-8 answer... CSS-gated) */}
          <div className="throw-animation__fxi" />

          {/* particle scatter */}
          <div className="throw-animation__particles">
            {particles.map((p, i) => (
              <div
                key={i}
                className="throw-animation__particle"
                style={
                  {
                    '--p-angle': `${p.angle}deg`,
                    '--p-dist': `${p.dist}px`,
                    '--p-size': `${p.size}px`,
                    '--p-delay': `${p.delay}s`,
                    '--p-color': p.useAlt ? 'var(--c2)' : 'var(--c1)',
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* LINGER -- stain / scorch residue (messy items only) */}
      {phase === 'linger' && t.linger && (
        <div
          className={`throw-animation__linger throw-animation__linger--${t.impact}`}
          style={{ left: toPos.x, top: toPos.y }}
        />
      )}
    </div>
  );
}

// =================================================================================
// CONTAINER -- Manages Multiple Active Throws
// =================================================================================

interface ThrowAnimationContainerProps {
  events: ThrowEvent[];
  seatPositions: Map<number, { x: number; y: number }>;
  onEventComplete: (eventId: string) => void;
}

export function ThrowAnimationContainer({
  events,
  seatPositions,
  onEventComplete,
}: ThrowAnimationContainerProps) {
  const handleComplete = useCallback(
    (eventId: string) => {
      onEventComplete(eventId);
    },
    [onEventComplete]
  );

  return (
    <div className="throw-animation-container">
      {events.map((event) => (
        <ThrowAnimation
          key={event.id}
          event={event}
          seatPositions={seatPositions}
          onComplete={() => handleComplete(event.id)}
        />
      ))}
    </div>
  );
}

export default ThrowAnimation;
