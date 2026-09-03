/**
 * VIPBenefitsGrid — Tier-specific benefits grid with locked/unlocked states
 */

import React from 'react';
import { VIP_TIERS, getTierByPoints, VIPTierId } from '../../constants/vipTiers';
import './VIPBenefitsGrid.css';

interface Benefit {
  id: string;
  icon: string;
  label: string;
  description: string;
  unlockedAtTier: VIPTierId;
}

const BENEFITS: Benefit[] = [
  {
    id: 'rakeback',
    icon: '◆',
    label: 'Rakeback',
    description: 'Earn Cashback On Every Hand',
    unlockedAtTier: 'bronze',
  },
  {
    id: 'tournaments',
    icon: '◈',
    label: 'Tournament Tickets',
    description: 'Monthly Free Tournament Entries',
    unlockedAtTier: 'silver',
  },
  {
    id: 'priority',
    icon: '▲',
    label: 'Priority Support',
    description: '24/7 Dedicated Customer Support',
    unlockedAtTier: 'gold',
  },
  {
    id: 'exclusive_table',
    icon: '▦',
    label: 'Exclusive Tables',
    description: 'Access Private High-Stakes Tables',
    unlockedAtTier: 'platinum',
  },
  {
    id: 'monthly_bonus',
    icon: '◈',
    label: 'Monthly Bonus',
    description: 'Exclusive Bonus Multipliers',
    unlockedAtTier: 'gold',
  },
  {
    id: 'badge_frame',
    icon: '★',
    label: 'Custom Badges',
    description: 'Exclusive Avatar Frames & Badges',
    unlockedAtTier: 'silver',
  },
  {
    id: 'vip_events',
    icon: '★',
    label: 'VIP Events',
    description: 'Invitation To Exclusive Tournaments',
    unlockedAtTier: 'diamond',
  },
  {
    id: 'point_multiplier',
    icon: '★',
    label: 'Point Multiplier',
    description: 'Earn Points Faster On All Actions',
    unlockedAtTier: 'bronze',
  },
];

interface VIPBenefitsGridProps {
  currentPoints: number;
}

export const VIPBenefitsGrid: React.FC<VIPBenefitsGridProps> = ({ currentPoints }) => {
  const currentTier = getTierByPoints(currentPoints);
  const currentTierIndex = VIP_TIERS.findIndex((t) => t.id === currentTier.id);

  const getBenefitStatus = (benefit: Benefit) => {
    const benefitTierIndex = VIP_TIERS.findIndex((t) => t.id === benefit.unlockedAtTier);
    return benefitTierIndex <= currentTierIndex;
  };

  return (
    <div className="vip-benefits-grid">
      <div className="benefits-header">
        <h3>Your VIP Benefits</h3>
        <p>Unlock More Perks As You Climb The VIP Ladder</p>
      </div>

      <div className="benefits-container">
        {BENEFITS.map((benefit, idx) => {
          const isUnlocked = getBenefitStatus(benefit);
          const unlockedTier = VIP_TIERS.find((t) => t.id === benefit.unlockedAtTier);

          return (
            <div
              key={benefit.id}
              className={`benefit-card ${isUnlocked ? 'unlocked' : 'locked'}`}
              style={
                {
                  '--tier-color': isUnlocked ? unlockedTier?.color : 'rgba(255, 255, 255, 0.1)',
                  '--accent-color': isUnlocked ? unlockedTier?.accentColor : 'rgba(0, 0, 0, 0.1)',
                  '--delay': `${idx * 0.05}s`,
                } as React.CSSProperties
              }
            >
              {!isUnlocked && (
                <div className="lock-overlay">
                  <span className="lock-icon">◈</span>
                </div>
              )}

              <div className="benefit-top">
                <span className="benefit-icon">{benefit.icon}</span>
                {!isUnlocked && <span className="unlock-badge">{unlockedTier?.name}</span>}
                {isUnlocked && <span className="checkmark">✓</span>}
              </div>

              <div className="benefit-content">
                <h4 className="benefit-label">{benefit.label}</h4>
                <p className="benefit-description">{benefit.description}</p>
              </div>

              {isUnlocked && (
                <div
                  className="benefit-glow"
                  style={{ boxShadow: `inset 0 0 12px ${unlockedTier?.color}` }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Tier-specific benefits showcase */}
      <div className="tier-benefits-section">
        <h4>Tier Benefits At {currentTier.name}</h4>
        <div className="tier-benefits-display">
          <div className="tier-benefit-item">
            <span className="label">Rakeback</span>
            <span className="value">{currentTier.rakeback}%</span>
          </div>
          <div className="tier-benefit-item">
            <span className="label">Monthly Tickets</span>
            <span className="value">{currentTier.tournyTickets}</span>
          </div>
          <div className="tier-benefit-item">
            <span className="label">Point Multiplier</span>
            <span className="value">{currentTier.multiplier}x</span>
          </div>
          {currentTier.priority && (
            <div className="tier-benefit-item">
              <span className="label">Priority Support</span>
              <span className="value">✓</span>
            </div>
          )}
          {currentTier.exclusiveTable && (
            <div className="tier-benefit-item">
              <span className="label">Exclusive Tables</span>
              <span className="value">✓</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VIPBenefitsGrid;
