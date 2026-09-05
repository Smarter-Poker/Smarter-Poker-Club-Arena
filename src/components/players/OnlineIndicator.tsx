import React from 'react';
import './OnlineIndicator.css';

interface OnlineIndicatorProps {
  status: 'online' | 'away' | 'busy' | 'offline' | 'playing';
  showLabel?: boolean;
  size?: 'small' | 'medium' | 'large';
}

const STATUS_CONFIG = {
  online: { color: '#4ade80', label: 'Online' },
  away: { color: '#fbbf24', label: 'Away' },
  busy: { color: '#f87171', label: 'Busy' },
  offline: { color: '#64748b', label: 'Offline' },
  playing: { color: '#60a5fa', label: 'Playing' },
};

export const OnlineIndicator: React.FC<OnlineIndicatorProps> = ({
  status,
  showLabel = false,
  size = 'medium',
}) => {
  const config = STATUS_CONFIG[status];

  return (
    <div className={`online-indicator size-${size}`}>
      <span className={`indicator-dot ${status}`} style={{ backgroundColor: config.color }} />
      {showLabel && (
        <span className="online-indicator__indicator-label" style={{ color: config.color }}>
          {config.label}
        </span>
      )}
    </div>
  );
};

export default OnlineIndicator;
