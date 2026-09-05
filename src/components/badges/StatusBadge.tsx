import React from 'react';
import './StatusBadge.css';

interface StatusBadgeProps {
  status: 'active' | 'inactive' | 'pending' | 'verified' | 'banned' | 'vip';
  size?: 'small' | 'medium';
  showDot?: boolean;
}

const STATUS_CONFIG = {
  active: { label: 'Active', color: '#4ade80' },
  inactive: { label: 'Inactive', color: '#64748b' },
  pending: { label: 'Pending', color: '#fbbf24' },
  verified: { label: 'Verified', color: '#60a5fa' },
  banned: { label: 'Banned', color: '#f87171' },
  vip: { label: 'VIP', color: '#ffd700' },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  size = 'medium',
  showDot = true,
}) => {
  const config = STATUS_CONFIG[status];

  return (
    <span
      className={`status-badge__status-badge status-${status} size-${size}`}
      style={{ '--status-color': config.color } as React.CSSProperties}
    >
      {showDot && <span className="status-dot" />}
      {config.label}
    </span>
  );
};

export default StatusBadge;
