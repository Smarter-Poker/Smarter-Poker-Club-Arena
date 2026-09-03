import React from 'react';
import './ProgressBar.css';

interface ProgressBarProps {
  value: number;
  max?: number;
  showLabel?: boolean;
  size?: 'small' | 'medium' | 'large';
  variant?: 'default' | 'success' | 'warning' | 'danger';
  animated?: boolean;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 100,
  showLabel = false,
  size = 'medium',
  variant = 'default',
  animated = false,
}) => {
  const percentage = Math.min((value / max) * 100, 100);

  return (
    <div className={`progress-bar size-${size}`}>
      <div
        className={`progress-fill variant-${variant} ${animated ? 'animated' : ''}`}
        style={{ width: `${percentage}%` }}
      />
      {showLabel && <span className="progress-label">{Math.round(percentage)}%</span>}
    </div>
  );
};

export default ProgressBar;
