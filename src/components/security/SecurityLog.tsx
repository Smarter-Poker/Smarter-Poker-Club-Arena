import React from 'react';
import { formatRelativeShort } from '../../lib/date';
import './SecurityLog.css';

interface SecurityEvent {
  id: string;
  type:
    | 'login'
    | 'logout'
    | 'password_change'
    | '2fa_enabled'
    | '2fa_disabled'
    | 'failed_login'
    | 'suspicious';
  description: string;
  ip: string;
  location: string;
  timestamp: Date;
  isAlert?: boolean;
}

interface SecurityLogProps {
  events: SecurityEvent[];
  maxItems?: number;
}

const EVENT_ICONS: Record<string, string> = {
  login: '',
  logout: '',
  password_change: '',
  '2fa_enabled': '',
  '2fa_disabled': '',
  failed_login: '',
  suspicious: '',
};

export const SecurityLog: React.FC<SecurityLogProps> = ({ events, maxItems = 20 }) => {
  const displayEvents = events.slice(0, maxItems);

  return (
    <div className="security-log">
      <div className="log-header">
        <h3> Security Activity</h3>
      </div>

      <div className="log-events">
        {displayEvents.map((event) => (
          <div key={event.id} className={`log-event ${event.isAlert ? 'alert' : ''}`}>
            <div className="event-icon">{EVENT_ICONS[event.type] || ''}</div>
            <div className="event-content">
              <div className="event-description">{event.description}</div>
              <div className="event-meta">
                {event.location} • {event.ip} • {formatRelativeShort(event.timestamp)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {events.length > maxItems && (
        <div className="log-footer">
          <button className="view-more-btn">View All ({events.length})</button>
        </div>
      )}
    </div>
  );
};

export default SecurityLog;
