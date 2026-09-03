import React from 'react';
import './LevelBadge.css';

interface LevelBadgeProps {
  level: number;
  size?: 'small' | 'medium' | 'large';
  showLabel?: boolean;
}

const getLevelColor = (level: number) => {
  if (level >= 50) return '#ffd700';
  if (level >= 40) return '#e5e4e2';
  if (level >= 30) return '#f97316';
  if (level >= 20) return '#a78bfa';
  if (level >= 10) return '#60a5fa';
  return '#94a3b8';
};

export const LevelBadge: React.FC<LevelBadgeProps> = ({
  level,
  size = 'medium',
  showLabel = true,
}) => {
  const color = getLevelColor(level);

  return (
    <div
      className={`level-badge size-${size}`}
      style={{ '--level-color': color } as React.CSSProperties}
    >
      <span className="level-number">{level}</span>
      {showLabel && <span className="level-label">LVL</span>}
    </div>
  );
};

export default LevelBadge;
