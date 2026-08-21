/**
 * =================================================================================
 *  THROW ANIMATION -- Dynamic 3D Throwable Display (2026-08-20 rebuild)
 * =================================================================================
 *
 * PokerBros-style multi-phase throw choreography, driven entirely by the
 * per-item metadata in ThrowableService (physics / impact / sound / weight /
 * linger / colors / spin):
 *
 *   WINDUP  (140ms)  item pops + scales up at the thrower's seat
 *   FLIGHT  (420-1100ms, per physics) parabola / fastball / lob / float /
 *                    drop-from-above / S-curve swoop / corkscrew spiral,
 *                    with tumble spin and a motion trail
 *   IMPACT  (~820ms) per-profile FX: splat goo, liquid splash, elastic
 *                    bounce, dust thud, fireball explosion, shard shatter,
 *                    electric zap, glitter sparkle, confetti burst --
 *                    plus squash-and-stretch, shockwave ring, particle
 *                    scatter, screen shake for heavy items
 *   LINGER  (2.5s)   stain/scorch residue for messy items
 *
 * AUDIO -- owned HERE, not by the send/receive hooks, so the whoosh fires at
 * launch and the item-specific SFX lands exactly on impact for both the
 * thrower and every receiving client. (useTableAnimations used to play a
 * generic thud at SEND time -- before anything had landed.)
 *
 * Renders the 49 3D images from Supabase storage; pure-black backgrounds are
 * erased by mix-blend-mode: screen (see .throwable-img in ThrowAnimation.css).
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { ThrowEvent } from '../../services/ThrowableService';
import type { ThrowPhysics } from '../../services/ThrowableService';
import { throwableSoundService } from '../../services/ThrowableSoundService';
import { ThrowableImage } from './ThrowableImage';
import './ThrowAnimation.css';

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

  const fromPos = seatPositions.get(event.fromSeat);
  const toPos = seatPositions.get(event.toSeat);

  const t = event.throwable;
  const physics = PHYSICS[t.physics] || PHYSICS.arc;
  const isHeavy = t.weight === 'heavy';

  // UI-AUDIT #1 (kept from the previous system): the container passes a new
  // `() => handleComplete(event.id)` arrow on every render. Keeping onComplete
  // in effect deps cleared and restarted the phase timers on each table
  // re-render -- projectiles could fly forever. Ref it.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    // WINDUP -> FLIGHT (launch whoosh)
    at(WINDUP_DURATION, () => {
      setPhase('flight');
      try {
        throwableSoundService.playLaunch(t.weight);
      } catch {
        /* audio is best-effort */
      }
    });

    // FLIGHT -> IMPACT (item SFX + shake)
    at(WINDUP_DURATION + physics.duration, () => {
      setPhase('impact');
      try {
        throwableSoundService.playImpact(t.sound, t.weight);
      } catch {
        /* audio is best-effort */
      }
      if (isHeavy) {
        const table = document.querySelector('.poker-table, .table-layout, [data-table]');
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
          <ThrowableImage throwableId={t.id} size={44} />
        </div>
      )}

      {/* FLIGHT -- physics-profiled trajectory with spin + trail */}
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
            } as React.CSSProperties
          }
        >
          {/* trail ghosts (staggered, fading copies) */}
          <div className="throw-animation__trail throw-animation__trail--1">
            <ThrowableImage throwableId={t.id} size={48} />
          </div>
          <div className="throw-animation__trail throw-animation__trail--2">
            <ThrowableImage throwableId={t.id} size={48} />
          </div>
          <div className="throw-animation__spinner">
            <ThrowableImage throwableId={t.id} size={48} />
          </div>
        </div>
      )}

      {/* IMPACT -- per-profile FX at the target seat */}
      {phase === 'impact' && (
        <div
          className={`throw-animation__impact throw-animation__impact--${t.impact}`}
          style={{ left: toPos.x, top: toPos.y }}
        >
          {/* explosion flash / fireball layers (explode + zap only, CSS-gated) */}
          <div className="throw-animation__flash" />
          <div className="throw-animation__fireball" />

          {/* squash-and-stretch item */}
          <div className="throw-animation__impact-icon">
            <ThrowableImage throwableId={t.id} size={64} />
          </div>

          {/* shockwave ring */}
          <div className="throw-animation__burst" />

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
