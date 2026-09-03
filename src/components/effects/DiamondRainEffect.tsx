/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND RAIN EFFECT — Animated particle overlay for diamond earning events
 * ═══════════════════════════════════════════════════════════════════════════════
 * CSS-driven particle system with falling + rotating diamond SVGs.
 * Usage: <DiamondRainEffect active={showRain} onComplete={() => setShowRain(false)} />
 */

import { useEffect, useState, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import './DiamondRainEffect.css';

interface DiamondRainEffectProps {
  /** When true, triggers the rain animation */
  active: boolean;
  /** Called when the animation completes */
  onComplete?: () => void;
  /** Number of particles to spawn */
  count?: number;
  /** Duration in ms */
  duration?: number;
}

interface Particle {
  id: number;
  left: number; // % from left
  delay: number; // animation delay s
  size: number; // px
  rotation: number; // initial rotation deg
  speed: number; // duration multiplier
}

export default function DiamondRainEffect({
  active,
  onComplete,
  count = 20,
  duration = 2500,
}: DiamondRainEffectProps) {
  const [particles, setParticles] = useState<Particle[]>([]);
  // Stabilize onComplete to prevent re-trigger loop when parent passes inline callback
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!active) {
      setParticles([]);
      return;
    }

    // Generate random particles
    const newParticles: Particle[] = Array.from({ length: count }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.8,
      size: 16 + Math.random() * 16,
      rotation: Math.random() * 360,
      speed: 0.8 + Math.random() * 0.6,
    }));

    setParticles(newParticles);

    const timer = setTimeout(() => {
      if (!isMounted.current) return;
      setParticles([]);
      onCompleteRef.current?.();
    }, duration);

    return () => clearTimeout(timer);
  }, [active, count, duration]);

  if (particles.length === 0) return null;

  return (
    <div className="diamond-rain-overlay" aria-hidden="true">
      {particles.map((p) => (
        <div
          key={p.id}
          className="diamond-particle"
          style={
            {
              left: `${p.left}%`,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.speed * 2}s`,
              fontSize: `${p.size}px`,
              '--rotation': `${p.rotation}deg`,
            } as React.CSSProperties
          }
        >
          ◆
        </div>
      ))}
    </div>
  );
}
