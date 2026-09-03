import React from 'react';
import './LimitedOfferBadge.css';

interface LimitedOfferBadgeProps {
  type: 'limited' | 'exclusive' | 'flash' | 'vip' | 'hot';
  text?: string;
  pulse?: boolean;
}

const BADGE_CONFIG = {
  limited: { icon: '', color: '#f97316', defaultText: 'Limited Time' },
  exclusive: { icon: '', color: '#fbbf24', defaultText: 'Exclusive' },
  flash: { icon: '', color: '#ef4444', defaultText: 'Flash Sale' },
  vip: { icon: '', color: '#8b5cf6', defaultText: 'VIP Only' },
  hot: { icon: '', color: '#ec4899', defaultText: 'Hot Deal' },
};

export const LimitedOfferBadge: React.FC<LimitedOfferBadgeProps> = ({
  type,
  text,
  pulse = true,
}) => {
  const config = BADGE_CONFIG[type];
  const displayText = text || config.defaultText;

  return (
    <span
      className={`limited-offer-badge ${pulse ? 'pulse' : ''}`}
      style={
        {
          '--badge-color': config.color,
          '--badge-bg': `${config.color}20`,
        } as React.CSSProperties
      }
    >
      <span className="badge-icon">{config.icon}</span>
      <span className="badge-text">{displayText}</span>
    </span>
  );
};

export default LimitedOfferBadge;
