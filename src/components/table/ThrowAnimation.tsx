/**
 * =================================================================================
 *  THROW ANIMATION -- Premium Animated Throwable Display
 * =================================================================================
 *
 * Renders throwable animation from sender -> target seat with:
 * - Multi-phase parabolic arc trajectory
 * - Per-type impact effects (splatter, frost, sparks, etc.)
 * - Particle scatter system on landing
 * - Screen shake for heavy impacts
 * - Linger stain/residue for messy throws
 * - Custom SVG graphics (no emojis!)
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { ThrowEvent } from '../../services/ThrowableService';
import { THROWABLE_ICONS } from './ThrowableIcons';
import './ThrowAnimation.css';

// =================================================================================
// CONSTANTS
// =================================================================================

/** Throwables that trigger screen shake on impact */
const HEAVY_IMPACT_TYPES = new Set([
  'tomato',
  'pie',
  'water-balloon',
  'dragon',
  'tsunami',
  'lightning',
]);

/** Throwables that leave a linger stain */
const LINGER_TYPES = new Set(['tomato', 'egg', 'snowball', 'water-balloon', 'pie']);

/** Number of particles spawned on impact */
const PARTICLE_COUNT = 8;

/** Phase durations (ms) */
const FLIGHT_DURATION = 650;
const IMPACT_DURATION = 800;
const LINGER_DURATION = 2500;

// =================================================================================
// SINGLE THROW ANIMATION
// =================================================================================

interface ThrowAnimationProps {
  event: ThrowEvent;
  seatPositions: Map<number, { x: number; y: number }>;
  onComplete: () => void;
}

export function ThrowAnimation({ event, seatPositions, onComplete }: ThrowAnimationProps) {
  const [phase, setPhase] = useState<'throw' | 'impact' | 'linger' | 'done'>('throw');

  const fromPos = seatPositions.get(event.fromSeat);
  const toPos = seatPositions.get(event.toSeat);

  const throwableType = event.throwable.id;
  const isReaction = event.throwable.category === 'reactions';
  const isHeavy = HEAVY_IMPACT_TYPES.has(throwableType);
  const hasLinger = LINGER_TYPES.has(throwableType);

  useEffect(() => {
    // Flight phase
    const flightTimer = setTimeout(() => {
      setPhase('impact');

      // Trigger screen shake for heavy impacts
      if (isHeavy) {
        const table = document.querySelector('.poker-table, .table-layout, [data-table]');
        if (table) {
          table.classList.add('throw-animation--shake');
          setTimeout(() => table.classList.remove('throw-animation--shake'), 400);
        }
      }
    }, FLIGHT_DURATION);

    // Impact -> linger or done
    const impactTimer = setTimeout(() => {
      if (hasLinger) {
        setPhase('linger');
      } else {
        setPhase('done');
        onComplete();
      }
    }, FLIGHT_DURATION + IMPACT_DURATION);

    // Linger -> done
    const lingerTimer = hasLinger
      ? setTimeout(
          () => {
            setPhase('done');
            onComplete();
          },
          FLIGHT_DURATION + IMPACT_DURATION + LINGER_DURATION
        )
      : undefined;

    return () => {
      clearTimeout(flightTimer);
      clearTimeout(impactTimer);
      if (lingerTimer) clearTimeout(lingerTimer);
    };
  }, [onComplete, isHeavy, hasLinger]);

  // Generate particle elements
  const particles = useMemo(() => {
    return Array.from({ length: PARTICLE_COUNT }, (_, i) => (
      <div key={i} className="throw-animation__particle" />
    ));
  }, []);

  if (!fromPos || !toPos || phase === 'done') {
    return null;
  }

  // Get SVG icon component
  const IconComponent = THROWABLE_ICONS[throwableType];
  const renderIcon = (size: number) => {
    if (IconComponent) {
      return <IconComponent size={size} />;
    }
    return <span className="throw-animation__fallback">?</span>;
  };

  return (
    <div className="throw-animation">
      {/* Flying Object */}
      {phase === 'throw' && (
        <div
          className={`throw-animation__projectile ${
            isReaction ? 'throw-animation__projectile--float' : 'throw-animation__projectile--arc'
          }`}
          style={
            {
              '--from-x': `${fromPos.x}px`,
              '--from-y': `${fromPos.y}px`,
              '--to-x': `${toPos.x}px`,
              '--to-y': `${toPos.y}px`,
            } as React.CSSProperties
          }
        >
          <div className="throw-animation__icon">{renderIcon(48)}</div>
        </div>
      )}

      {/* Impact Effect */}
      {phase === 'impact' && (
        <div
          className="throw-animation__impact"
          data-type={throwableType}
          style={{
            left: toPos.x,
            top: toPos.y,
          }}
        >
          <div className="throw-animation__impact-icon">{renderIcon(64)}</div>
          <div className="throw-animation__burst" />
          <div className="throw-animation__particles">{particles}</div>
        </div>
      )}

      {/* Linger Stain (messy throwables only) */}
      {phase === 'linger' && hasLinger && (
        <div
          className="throw-animation__linger"
          data-type={throwableType}
          style={{
            left: toPos.x,
            top: toPos.y,
          }}
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
