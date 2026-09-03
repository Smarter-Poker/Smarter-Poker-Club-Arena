import React from 'react';
import './ConnectionStatus.css';

interface ConnectionStatusProps {
  status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting';
  showLabel?: boolean;
  latency?: number;
}

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  status,
  showLabel = true,
  latency,
}) => {
  const getStatusConfig = () => {
    switch (status) {
      case 'connected':
        return { color: '#4ade80', label: 'Connected', icon: '●' };
      case 'connecting':
        return { color: '#fbbf24', label: 'Connecting...', icon: '◐' };
      case 'reconnecting':
        return { color: '#f97316', label: 'Reconnecting...', icon: '↻' };
      case 'disconnected':
        return { color: '#f87171', label: 'Disconnected', icon: '○' };
    }
  };

  const config = getStatusConfig();

  return (
    <div className={`connection-status status-${status}`}>
      <span
        className={`status-icon ${status === 'connecting' || status === 'reconnecting' ? 'spinning' : ''}`}
        style={{ color: config.color }}
      >
        {config.icon}
      </span>
      {showLabel && <span className="status-label">{config.label}</span>}
      {latency !== undefined && status === 'connected' && (
        <span className="latency">{latency}ms</span>
      )}
    </div>
  );
};

export default ConnectionStatus;
