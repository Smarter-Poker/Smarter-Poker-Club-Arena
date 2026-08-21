import React from 'react';
import { formatRelativeShort } from '../../lib/date';
import './SessionManager.css';

interface Session {
  id: string;
  device: string;
  browser: string;
  location: string;
  ip: string;
  lastActive: Date;
  isCurrent: boolean;
}

interface SessionManagerProps {
  sessions: Session[];
  onTerminate?: (sessionId: string) => void;
  onTerminateAll?: () => void;
}

export const SessionManager: React.FC<SessionManagerProps> = ({
  sessions,
  onTerminate,
  onTerminateAll,
}) => {
  const getDeviceIcon = (device: string) => {
    if (device.includes('iPhone') || device.includes('Android')) return '□';
    if (device.includes('iPad') || device.includes('Tablet')) return '▢';
    return '■';
  };

  return (
    <div className="session-manager">
      <div className="manager-header">
        <div>
          <h3>Active Sessions</h3>
          <p>
            {sessions.length} Device{sessions.length !== 1 ? 's' : ''} Connected
          </p>
        </div>
        {sessions.length > 1 && (
          <button className="terminate-all-btn" onClick={onTerminateAll}>
            Logout All Others
          </button>
        )}
      </div>

      <div className="sessions-list">
        {sessions.map((session) => (
          <div key={session.id} className={`session-item ${session.isCurrent ? 'current' : ''}`}>
            <div className="session-icon">{getDeviceIcon(session.device)}</div>
            <div className="session-info">
              <div className="session-device">
                {session.browser} On {session.device}
                {session.isCurrent && <span className="current-badge">This Device</span>}
              </div>
              <div className="session-details">
                {session.location} • {session.ip} • {formatRelativeShort(session.lastActive)}
              </div>
            </div>
            {!session.isCurrent && (
              <button className="terminate-btn" onClick={() => onTerminate?.(session.id)}>
                Logout
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default SessionManager;
