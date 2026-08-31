import React from 'react';
import './VIPStatusCard.css';

interface VIPStatusCardProps {
  tier: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
  currentPoints: number;
  nextTierPoints?: number;
  benefits: string[];
  memberSince?: Date;
  /** What the points number represents (e.g. "VIP Points" or "Diamonds") */
  pointsLabel?: string;
}

const TIER_CONFIG = {
  bronze: { color: '#cd7f32', icon: '', label: 'Bronze' },
  silver: { color: '#c0c0c0', icon: '', label: 'Silver' },
  gold: { color: '#ffd700', icon: '', label: 'Gold' },
  platinum: { color: '#e5e4e2', icon: '', label: 'Platinum' },
  diamond: { color: '#b9f2ff', icon: '', label: 'Diamond' },
};

export const VIPStatusCard: React.FC<VIPStatusCardProps> = ({
  tier,
  currentPoints,
  nextTierPoints,
  benefits,
  memberSince,
  pointsLabel = 'VIP Points',
}) => {
  const config = TIER_CONFIG[tier];
  const progress = nextTierPoints ? Math.min((currentPoints / nextTierPoints) * 100, 100) : 100;

  return (
    <div
      className="vip-status-card"
      style={{ '--tier-color': config.color } as React.CSSProperties}
    >
      <div className="vip-header">
        <div className="vip-badge">
          <span className="badge-icon">{config.icon}</span>
          <div className="badge-info">
            <span className="tier-label">{config.label} VIP</span>
            {memberSince && (
              <span className="member-since">Member Since {memberSince.getFullYear()}</span>
            )}
          </div>
        </div>
      </div>

      <div className="points-section">
        <div className="points-display">
          <span className="points-value">{currentPoints.toLocaleString()}</span>
          <span className="points-label">{pointsLabel}</span>
        </div>

        {nextTierPoints && (
          <div className="progress-section">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }}></div>
            </div>
            <span className="progress-text">
              {currentPoints >= nextTierPoints
                ? 'Max Tier Reached!'
                : `${(nextTierPoints - currentPoints).toLocaleString()} ${pointsLabel} To Next Tier`}
            </span>
          </div>
        )}
      </div>

      <div className="benefits-preview">
        <h4>Your Benefits</h4>
        <ul>
          {benefits.slice(0, 3).map((benefit, i) => (
            <li key={i}>{benefit}</li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default VIPStatusCard;
