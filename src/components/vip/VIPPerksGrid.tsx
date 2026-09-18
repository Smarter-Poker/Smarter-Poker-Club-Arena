import React, { useState } from 'react';
import { ClubIcon, type ClubIconName } from '../club-buttons/ClubButtons';
import { formatPopupText } from '../../utils/popupStyle';
import './VIPPerksGrid.css';

export interface VIPPerk {
  id: string;
  icon: ClubIconName;
  title: string;
  description: string;
  value?: string;
  artworkSrc?: string;
  isLocked?: boolean;
  requiredTier?: string;
}

interface VIPPerksGridProps {
  perks: VIPPerk[];
}

function PerkVisual({ perk }: { perk: VIPPerk }) {
  const [artworkFailed, setArtworkFailed] = useState(false);
  const showArtwork = Boolean(perk.artworkSrc) && !artworkFailed;

  return (
    <div className={`perk-visual ${showArtwork ? 'perk-visual--artwork' : ''}`} aria-hidden="true">
      {showArtwork ? (
        <img
          src={perk.artworkSrc}
          alt=""
          className="perk-artwork"
          draggable={false}
          decoding="async"
          onError={() => setArtworkFailed(true)}
        />
      ) : (
        <ClubIcon name={perk.icon} className="perk-club-icon" />
      )}
    </div>
  );
}

export const VIPPerksGrid: React.FC<VIPPerksGridProps> = ({ perks }) => {
  return (
    <div className="vip-perks-grid">
      <div className="vip-perks-grid__heading">
        <h3>{formatPopupText('VIP Perks & Benefits')}</h3>
      </div>
      <div className="perks-container" role="list">
        {perks.map((perk) => (
          <div
            key={perk.id}
            className={`perk-card ${perk.artworkSrc ? 'perk-card--artwork' : ''} ${
              perk.isLocked ? 'locked' : ''
            }`}
            role="listitem"
          >
            <PerkVisual perk={perk} />
            <div className="perk-content">
              <h4>{formatPopupText(perk.title)}</h4>
              <p>{formatPopupText(perk.description)}</p>
              {perk.value && <span className="perk-value">{formatPopupText(perk.value)}</span>}
            </div>
            {perk.isLocked && perk.requiredTier && (
              <div className="lock-overlay">{formatPopupText(perk.requiredTier)}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default VIPPerksGrid;
