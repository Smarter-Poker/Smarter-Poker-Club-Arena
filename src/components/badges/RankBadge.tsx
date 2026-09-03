import React from 'react';
import './RankBadge.css';

interface RankBadgeProps {
  rank: number;
  label?: string;
  size?: 'small' | 'medium' | 'large';
}

const getRankConfig = (rank: number) => {
  if (rank === 1) return { icon: '', color: '#ffd700', label: '1st' };
  if (rank === 2) return { icon: '', color: '#c0c0c0', label: '2nd' };
  if (rank === 3) return { icon: '', color: '#cd7f32', label: '3rd' };
  return { icon: null, color: '#64748b', label: `#${rank}` };
};

export const RankBadge: React.FC<RankBadgeProps> = ({ rank, label, size = 'medium' }) => {
  const config = getRankConfig(rank);
  const displayLabel = label || config.label;

  return (
    <div
      className={`rank-badge rank-${rank <= 3 ? rank : 'other'} size-${size}`}
      style={{ '--rank-color': config.color } as React.CSSProperties}
    >
      {config.icon ? (
        <span className="rank-icon">{config.icon}</span>
      ) : (
        <span className="rank-number">{displayLabel}</span>
      )}
    </div>
  );
};

export default RankBadge;
