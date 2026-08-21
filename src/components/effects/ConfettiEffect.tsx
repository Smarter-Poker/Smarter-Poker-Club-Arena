import React from 'react';
import './ConfettiEffect.css';

interface ConfettiEffectProps {
  isActive: boolean;
  intensity?: 'light' | 'medium' | 'heavy' | 'jackpot';
  colors?: string[];
  duration?: number;
}

export const ConfettiEffect: React.FC<ConfettiEffectProps> = ({
  isActive,
  intensity = 'medium',
  colors = ['#ffd700', '#ff6b6b', '#4ecdc4', '#45b7d1', '#f7dc6f'],
  duration = 3000,
}) => {
  if (!isActive) return null;

  const particleCount =
    intensity === 'light' ? 30 : intensity === 'heavy' ? 100 : intensity === 'jackpot' ? 300 : 50;

  const particles = Array.from({ length: particleCount }, (_, i) => ({
    id: i,
    color: colors[i % colors.length],
    left: `${Math.random() * 100}%`,
    delay: `${Math.random() * 0.5}s`,
    size: `${4 + Math.random() * 6}px`,
    rotation: `${Math.random() * 360}deg`,
  }));

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
