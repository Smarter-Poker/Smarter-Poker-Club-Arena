/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ClubCardPanel — Reusable club card with metal frame + stats overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 * Mirrors ClubStatsPanel (Shark Club) exactly:
 *  - Frame template as background
 *  - Logo sits inside the recessed viewport
 *  - Dark stats bar div covers the template's white labels
 *  - Cyan labels + glowing values overlay at 79.5% (matching Shark Club)
 */

import React, { useState } from 'react';
import './ClubCardPanel.css';

interface ClubCardPanelProps {
  clubName: string;
  totalMembers: number;
  clubLevel: number;
  activePlayers: number;
  cardImageUrl?: string | null;
  logoUrl?: string | null;
}

export const ClubCardPanel: React.FC<ClubCardPanelProps> = ({
  clubName,
  totalMembers,
  clubLevel,
  activePlayers,
  cardImageUrl,
  logoUrl,
}) => {
  const [cardFailed, setCardFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  const useBakedCard = cardImageUrl && !cardFailed;
  const showLogo = !useBakedCard && logoUrl && !logoFailed;

  return (
    <div className="club-card-panel">
      {useBakedCard ? (
        /* ── MODE 1: Baked composite card ──────────────────────────────── */
        <img
          src={cardImageUrl}
          alt={`${clubName} Card`}
          className="club-card-panel-bg"
          loading="lazy"
          onError={() => setCardFailed(true)}
        />
      ) : (
        /* ── MODE 2: Fallback — frame template + logo overlay ──────── */
        <>
          <img
            src={`${import.meta.env.BASE_URL || '/'}images/club-card-frame-template.jpg`}
            alt={`${clubName} Card`}
            className="club-card-panel-bg club-card-frame-bg"
            loading="lazy"
          />
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
        </>
      )}

      {/* Dark stats bar — covers the template's white baked-in labels */}
      <div className="club-card-stats-bar-bg" />

      {/* Stats overlay — EXACT COPY of ClubStatsPanel layout */}
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
