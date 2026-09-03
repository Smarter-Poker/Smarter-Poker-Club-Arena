import React from 'react';
import './VIPPerksGrid.css';

interface Perk {
  id: string;
  icon: string;
  title: string;
  description: string;
  value?: string;
  isLocked?: boolean;
  requiredTier?: string;
}

interface VIPPerksGridProps {
  perks: Perk[];
  currentTier: string;
}

export const VIPPerksGrid: React.FC<VIPPerksGridProps> = ({ perks, currentTier }) => {
  return (
    <div className="vip-perks-grid">
      <h3>VIP Perks & Benefits</h3>
      <div className="perks-container">
        {perks.map((perk) => (
          <div key={perk.id} className={`perk-card ${perk.isLocked ? 'locked' : ''}`}>
            <div className="perk-icon">{perk.icon}</div>
            <div className="perk-content">
              <h4>{perk.title}</h4>
              <p>{perk.description}</p>
              {perk.value && <span className="perk-value">{perk.value}</span>}
            </div>
            {perk.isLocked && perk.requiredTier && (
              <div className="lock-overlay">{perk.requiredTier}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default VIPPerksGrid;
