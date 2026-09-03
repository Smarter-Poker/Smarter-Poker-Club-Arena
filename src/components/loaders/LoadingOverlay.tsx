import React from 'react';
import './LoadingOverlay.css';

interface LoadingOverlayProps {
  isLoading: boolean;
  message?: string;
  fullScreen?: boolean;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  isLoading,
  message = 'Loading...',
  fullScreen = false,
}) => {
  if (!isLoading) return null;

  return (
    <div className={`loading-overlay ${fullScreen ? 'full-screen' : ''}`}>
      <div className="loading-content">
        <div className="loading-spinner" />
        {message && <span className="loading-message">{message}</span>}
      </div>
    </div>
  );
};

export default LoadingOverlay;
