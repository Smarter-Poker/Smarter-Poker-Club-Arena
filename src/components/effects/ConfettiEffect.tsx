import React, { useMemo } from 'react';
import './ConfettiEffect.css';

interface ConfettiEffectProps {
  isActive: boolean;
  intensity?: 'light' | 'medium' | 'heavy';
  colors?: string[];
  duration?: number;
}

export const ConfettiEffect: React.FC<ConfettiEffectProps> = ({
  isActive,
  intensity = 'medium',
  colors = ['#ffd700', '#ff6b6b', '#4ecdc4', '#45b7d1', '#f7dc6f'],
  duration = 3000,
}) => {
  const particleCount = intensity === 'light' ? 30 : intensity === 'heavy' ? 100 : 50;

  // ANIMATION AUDIT 2026-08-28: this was built with Math.random() in the
  // render body — every parent re-render while active re-randomised all the
  // particles mid-fall and the burst visibly jittered. Memoised on the burst
  // identity so a re-render can never scramble a burst in flight. (Hooks
  // before the early return, per the rules of hooks.)
  const particles = useMemo(
    () =>
      Array.from({ length: particleCount }, (_, i) => ({
        id: i,
        color: colors[i % colors.length],
        left: `${Math.random() * 100}%`,
        delay: `${Math.random() * 0.5}s`,
        size: `${4 + Math.random() * 6}px`,
        rotation: `${Math.random() * 360}deg`,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isActive, particleCount]
  );

  if (!isActive) return null;

  return (
    <div
      className="confetti-effect"
      style={{ '--duration': `${duration}ms` } as React.CSSProperties}
    >
      {particles.map((p) => (
        <div
          key={p.id}
          className="confetti-particle"
          style={{
            left: p.left,
            animationDelay: p.delay,
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            transform: `rotate(${p.rotation})`,
          }}
        />
      ))}
    </div>
  );
};

export default ConfettiEffect;
