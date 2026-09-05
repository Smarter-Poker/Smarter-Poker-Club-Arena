/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONLINE STATUS INDICATOR — Player Presence Indicator
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import './OnlineIndicator.css';

interface OnlineIndicatorProps {
  status: 'online' | 'away' | 'disconnected' | 'offline';
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  lastSeen?: Date;
}

export function OnlineIndicator({
  status,
  showLabel = false,
  size = 'md',
  lastSeen,
}: OnlineIndicatorProps) {
  const getStatusLabel = () => {
    switch (status) {
      case 'online':
        return 'Online';
      case 'away':
        return 'Away';
      case 'disconnected':
        return 'Disconnected';
      case 'offline':
        if (lastSeen) {
          const diff = Date.now() - lastSeen.getTime();
          const mins = Math.floor(diff / (1000 * 60));
          if (mins < 60) return `${mins}m ago`;
          const hours = Math.floor(mins / 60);
          if (hours < 24) return `${hours}h ago`;
          return 'Offline';
        }
        return 'Offline';
    }
  };

  return (
    <div className={`online-indicator ${status} ${size}`}>
      <div className="indicator-dot" />
      {showLabel && <span className="online-indicator__indicator-label">{getStatusLabel()}</span>}
    </div>
  );
}

export default OnlineIndicator;
