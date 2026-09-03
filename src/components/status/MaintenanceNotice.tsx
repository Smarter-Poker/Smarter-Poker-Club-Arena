import React from 'react';
import { formatTime } from '../../lib/date';
import './MaintenanceNotice.css';

interface MaintenanceNoticeProps {
  scheduledTime?: Date;
  duration?: string;
  message?: string;
  isUrgent?: boolean;
}

export const MaintenanceNotice: React.FC<MaintenanceNoticeProps> = ({
  scheduledTime,
  duration = '30 minutes',
  message,
  isUrgent = false,
}) => {
  return (
    <div className={`maintenance-notice ${isUrgent ? 'urgent' : ''}`}>
      <span className="notice-icon">{isUrgent ? '' : '◇'}</span>
      <div className="notice-content">
        {message || (
          <>
            Scheduled Maintenance {scheduledTime ? `At ${formatTime(scheduledTime)}` : 'Soon'}
            {duration && <span className="duration">~{duration}</span>}
          </>
        )}
      </div>
    </div>
  );
};

export default MaintenanceNotice;
