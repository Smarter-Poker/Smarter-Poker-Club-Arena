import React from 'react';
import './Alert.css';

interface AlertProps {
  type: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message: string;
  onClose?: () => void;
}

const icons = {
  info: '',
  success: '',
  warning: '',
  error: '✕',
};

export const Alert: React.FC<AlertProps> = ({ type, title, message, onClose }) => {
  return (
    <div className={`alert type-${type}`}>
      <span className="alert-icon">{icons[type]}</span>
      <div className="alert-content">
        {title && <div className="alert__alert-title">{title}</div>}
        <div className="alert-message">{message}</div>
      </div>
      {onClose && (
        <button className="alert-close" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
};

export default Alert;
