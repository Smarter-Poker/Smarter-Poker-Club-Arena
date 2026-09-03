import React from 'react';
import './VIPProgressRing.css';

interface VIPProgressRingProps {
  current: number;
  total: number;
  tier: string;
  nextTier?: string;
  size?: number;
  strokeWidth?: number;
}

export const VIPProgressRing: React.FC<VIPProgressRingProps> = ({
  current,
  total,
  tier,
  nextTier,
  size = 160,
  strokeWidth = 12,
}) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const progress = Math.min((current / total) * 100, 100);
  const offset = circumference - (progress / 100) * circumference;

  return (
    <div className="vip-progress-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        {/* Background circle */}
        <circle
          className="ring-bg"
          strokeWidth={strokeWidth}
          r={radius}
          cx={size / 2}
          cy={size / 2}
        />
        {/* Progress circle */}
        <circle
          className="ring-progress"
          strokeWidth={strokeWidth}
          r={radius}
          cx={size / 2}
          cy={size / 2}
          style={{
            strokeDasharray: `${circumference} ${circumference}`,
            strokeDashoffset: offset,
          }}
        />
      </svg>

      <div className="ring-content">
        <span className="progress-percent">{Math.round(progress)}%</span>
        <span className="tier-name">{tier}</span>
      </div>

      {nextTier && <div className="next-tier-badge">Next: {nextTier}</div>}
    </div>
  );
};

export default VIPProgressRing;
