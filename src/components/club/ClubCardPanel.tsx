/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ClubCardPanel — Reusable club card with metal frame + stats overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 * Generalized version of ClubStatsPanel. Uses the club-card-frame-template
 * background with overlaid club name, optional logo, and live stats.
 * Works for ANY club (Club JAQK, Midway Union, custom user clubs, etc.)
 */

import React, { useState } from 'react';
import './ClubCardPanel.css';

interface ClubCardPanelProps {
  clubName: string;
  totalMembers: number;
  clubLevel: number;
  activePlayers: number;
  logoUrl?: string | null;
}

export const ClubCardPanel: React.FC<ClubCardPanelProps> = ({
  clubName,
  totalMembers,
  clubLevel,
  activePlayers,
  logoUrl,
}) => {
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = logoUrl && !logoFailed;

  return (
    <div className="club-card-panel">
      {/* Background frame image (browser caches) */}
      <img
        src={`${import.meta.env.BASE_URL || '/'}images/club-card-frame-template.jpg`}
        alt={`${clubName} Card`}
        className="club-card-panel-bg"
        loading="lazy"
      />

      {/* Club name at the top */}
      <div className="club-card-name-overlay">
        <span className="club-card-name">{clubName}</span>
      </div>

      {/* Optional logo in the center */}
      <div className="club-card-logo-container">
        {showLogo ? (
          <img
            src={logoUrl}
            alt=""
            className="club-card-logo-img"
            loading="lazy"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <div className="club-card-logo-fallback">♠</div>
        )}
      </div>

      {/* Stats overlay — same positions as ClubStatsPanel */}
      <div className="club-card-stats-overlay">
        <div className="club-card-stats-group club-card-members-group">
          <span className="club-card-stat-label">
            TOTAL
            <br />
            MEMBERS
          </span>
          <span className="club-card-stat-value">{Math.max(1, totalMembers).toLocaleString()}</span>
        </div>

        <div className="club-card-stats-group club-card-level-group">
          <span className="club-card-stat-label">CLUB LEVEL</span>
          <span className="club-card-stat-value">{Math.max(1, clubLevel)}</span>
        </div>

        <div className="club-card-stats-group club-card-active-group">
          <span className="club-card-stat-label">
            ACTIVE
            <br />
            PLAYERS
          </span>
          <span className="club-card-stat-value">{activePlayers?.toLocaleString() || '0'}</span>
        </div>
      </div>
    </div>
  );
};

export default ClubCardPanel;
