import React from 'react';
import './VIPUpgradeModal.css';

interface UpgradeTier {
  name: string;
  price: number;
  period: string;
  benefits: string[];
  isPopular?: boolean;
}

interface VIPUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentTier: string;
  tiers: UpgradeTier[];
  onUpgrade?: (tierName: string) => void;
}

export const VIPUpgradeModal: React.FC<VIPUpgradeModalProps> = ({
  isOpen,
  onClose,
  currentTier,
  tiers,
  onUpgrade,
}) => {
  if (!isOpen) return null;

  return (
    <div className="vip-upgrade-overlay" onClick={onClose}>
      <div className="vip-upgrade-modal" onClick={(e) => e.stopPropagation()}>
        <button className="vipupgrade-modal__close-btn" onClick={onClose}>
          ×
        </button>

        <div className="modal-header">
          <h2> Upgrade Your VIP Status</h2>
          <p>Unlock Exclusive Perks And Rewards</p>
        </div>

        <div className="tiers-container">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`vipupgrade-modal__tier-card ${tier.isPopular ? 'popular' : ''} ${tier.name === currentTier ? 'current' : ''}`}
            >
              {tier.isPopular && <span className="popular-badge">Most Popular</span>}

              <h3>{tier.name}</h3>
              <div className="tier-price">
                <span className="price">{tier.price}</span>
                <span className="period">/{tier.period}</span>
              </div>

              <ul className="tier-benefits">
                {tier.benefits.map((benefit, i) => (
                  <li key={i}> {benefit}</li>
                ))}
              </ul>

              {tier.name === currentTier ? (
                <button className="tier-btn current" disabled>
                  Current Plan
                </button>
              ) : (
                <button className="tier-btn upgrade" onClick={() => onUpgrade?.(tier.name)}>
                  Upgrade
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default VIPUpgradeModal;
