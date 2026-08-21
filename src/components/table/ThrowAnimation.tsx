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

/**
 * Projectile size per weight -- an anvil should LOOK heavier than a tennis ball.
 * Dan 2026-08-21: "each throwable should be about double its current size when
 * thrown." Doubled from 42/48/58 and 56/64/76. The renders are fetched at the
 * 160px retina bucket, so they stay sharp at these sizes.
 */
const FLIGHT_SIZE: Record<string, number> = { light: 84, medium: 96, heavy: 116 };
const IMPACT_SIZE: Record<string, number> = { light: 112, medium: 128, heavy: 152 };

/**
 * Dan 2026-08-21: "should last about 3-4 seconds from the time it's thrown
 * until the time it disappears."
 *
 * The old sequence ran ~1.6s for a plain item (140 windup + 650 flight + 820
 * impact) while messy items ran to 6.4s because `linger` was appended AFTER
 * the impact. Both wrong, in opposite directions.
 *
 * Now every throw targets the same wall-clock life. Flight keeps its tuned,
 * snappy per-physics duration; the remainder is spent at the landing site,
 * where there is actually something to look at. The stain no longer extends
 * the total -- it runs CONCURRENTLY with the impact, which is also what it
 * should have been doing all along (a splat appears when the thing lands, not
 * after it has finished bouncing).
 */
const TARGET_TOTAL_MS = 3500;
/** Floor so a very slow lob still gets a readable landing beat. */
const MIN_IMPACT_LIFE_MS = 1400;

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

/**
 * Per-item IMPACT durations (ms, default 820). Presentation-layer tuning:
 * a giggle needs a full second to rock through, the magic 8-ball's answer
 * must be READABLE, the card flick is over in a snap. Signature CSS reads
 * the value through --impact-dur so keyframes stretch with it.
 */
const IMPACT_MS: Record<string, number> = {
  laughing_emoji: 1000,
  cool_sunglasses_emoji: 1150,
  heart: 950,
  thumbs_up: 950,
  thumbs_down: 950,
  banana_peel: 950,
  cake: 900,
  boxing_glove: 900,
  basketball: 950,
  dice: 900,
  magic_8_ball: 1250,
  bowling_ball: 950,
  champagne: 950,
  cash_stack: 950,
  alien: 950,
  ghost: 1000,
  doge: 950,
  shark: 950,
  mouse_card: 700,
};

/**
 * Per-item LINGER durations (ms, default 2500) for items with linger: true.
 * A bomb's scorch outlives a splash of water; poop... lingers.
 */
const LINGER_MS: Record<string, number> = {
  tomato: 3400,
  cracked_egg: 3000,
  pizza_slice: 3000,
  cake: 3200,
  poop: 4200,
  water_gun: 2200,
  anvil: 3000,
  trash_can: 2800,
  snowman: 2800,
  beer: 2500,
  champagne: 2600,
  coffee: 2400,
  bomb: 4500,
  rocket: 4000,
};

/** Per-item particle-count overrides (default comes from the impact profile). */
const PARTICLE_COUNT: Record<string, number> = {
  cash_stack: 20, // it should RAIN money
  fireworks: 22,
  chicken: 12, // feather burst
  snowman: 14,
};

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
  const [phase, setPhase] = useState<'windup' | 'flight' | 'impact' | 'done'>('windup');

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
  // Motion duration of the landing animation (squash, bounce, per-item
  // signature). Unchanged and still per-item: this is the CHOREOGRAPHY.
  const impactMs = IMPACT_MS[t.id] || IMPACT_DURATION;
  // How long the landed item stays on screen. Owns opacity only, so stretching
  // it never slows the motion above -- the item lands at its tuned pace, then
  // simply sits there before fading.
  const lifeMs = Math.max(MIN_IMPACT_LIFE_MS, TARGET_TOTAL_MS - WINDUP_DURATION - physics.duration);
  // The stain fades out with the item rather than after it.
  const lingerMs = Math.min(LINGER_MS[t.id] || LINGER_DURATION, lifeMs);
  const isHeavy = t.weight === 'heavy';
  const flightSize = FLIGHT_SIZE[t.weight] || 96;
  const impactSize = IMPACT_SIZE[t.weight] || 128;

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

    // IMPACT -> DONE. There is no separate linger phase any more: the stain is
    // rendered inside the impact phase and fades on its own timer, so a messy
    // item no longer runs 6+ seconds while a clean one is gone in 1.6.
    at(WINDUP_DURATION + physics.duration + lifeMs, () => {
      setPhase('done');
      onCompleteRef.current();
    });

    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  // Randomized particle scatter, stable per event
  const particles = useMemo<ParticleSpec[]>(() => {
    const count = PARTICLE_COUNT[t.id] ?? PARTICLES[t.impact] ?? 10;
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
          style={
            {
              left: toPos.x,
              top: toPos.y,
              '--impact-dur': `${impactMs}ms`,
              '--life-dur': `${lifeMs}ms`,
              '--linger-dur': `${lingerMs}ms`,
            } as React.CSSProperties
          }
        >
          {/* explosion flash / fireball / smoke layers (CSS-gated by profile) */}
          <div className="throw-animation__flash" />
          <div className="throw-animation__fireball" />
          <div className="throw-animation__smoke throw-animation__smoke--1" />
          <div className="throw-animation__smoke throw-animation__smoke--2" />
          <div className="throw-animation__smoke throw-animation__smoke--3" />

          {/* squash-and-stretch item with additive glow */}
          <div className="throw-animation__impact-glow" />
          {/* Two nested elements on purpose. The inner one owns the MOTION
              (squash / bounce / per-item signature) at its tuned duration; the
              outer owns OPACITY for the whole landing life. Splitting them is
              what lets a throw last 3.5s without the landing animation playing
              in slow motion. */}
          <div className="throw-animation__impact-life">
            <div className="throw-animation__impact-icon">
              <ThrowableImage throwableId={t.id} size={impactSize} />
            </div>
          </div>

          {/* shockwave ring */}
          <div className="throw-animation__burst" />

          {/* stain / scorch residue for messy items. Concurrent with the
              impact, not appended after it: a splat appears the moment the
              thing lands. */}
          {t.linger && (
            <div className={`throw-animation__linger throw-animation__linger--${t.impact}`} />
          )}

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
