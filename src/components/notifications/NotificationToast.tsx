import React, { useEffect, useState } from 'react';
import './NotificationToast.css';

interface NotificationToastProps {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  duration?: number;
  onClose: () => void;
}

const TYPE_CONFIG = {
  info: { icon: '', color: '#60a5fa' },
  success: { icon: '', color: '#4ade80' },
  warning: { icon: '', color: '#fbbf24' },
  error: { icon: '', color: '#f87171' },
};

export const NotificationToast: React.FC<NotificationToastProps> = ({
  id,
  type,
  title,
  message,
  duration = 5000,
  onClose,
}) => {
  const [isExiting, setIsExiting] = useState(false);
  const config = TYPE_CONFIG[type];

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onClose, 300);
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(onClose, 300);
  };

  return (
    <div
      className={`notification-toast ${isExiting ? 'exiting' : ''}`}
      style={{ '--toast-color': config.color } as React.CSSProperties}
    >
      <div className="toast-icon">{config.icon}</div>
      <div className="toast-content">
        <div className="toast-title">{title}</div>
        {message && <div className="toast-message">{message}</div>}
      </div>
      <button className="toast-close" onClick={handleClose}>
        ×
      </button>
      <div className="toast-progress" style={{ animationDuration: `${duration}ms` }} />
    </div>
  );
};

export default NotificationToast;
